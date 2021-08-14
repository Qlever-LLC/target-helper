/* Copyright 2021 Qlever LLC
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { readFileSync } from 'fs';

import moment from 'moment';
import _ from 'lodash';
import debug from 'debug';
import oerror from '@overleaf/o-error';
import {Promise as bPromise} from 'bluebird';

import { Change, connect, OADAClient } from '@oada/client';
import type { WorkerFunction, Logger } from '@oada/jobs';
import { assert as assertJob } from '@oada/types/oada/service/job';
import type { Jobs } from '@oada/types/oada/service/jobs';
import type Update from '@oada/types/oada/service/job/update';
import { ListWatch } from '@oada/list-lib';
// @ts-ignore too lazy to figure out types
import tsig from '@trellisfw/signatures';

import tree from './tree';
import config from './config';

const error = debug('target-helper:error');
const warn = debug('target-helper:warn');
const info = debug('target-helper:info');
const trace = debug('target-helper:trace');

// You can generate a signing key pair by running `oada-certs --create-keys`
const prvKey = JSON.parse(
  readFileSync(config.get('signing.privateJWK')).toString()
);
const pubKey = tsig.keys.pubFromPriv(prvKey);
const header: { jwk: {}; jku?: string; kid?: string } = { jwk: pubKey };
if (prvKey.jku) {
  header.jku = prvKey.jku; // make sure we keep jku and kid
}
if (prvKey.kid) {
  header.kid = prvKey.kid;
}
const signer = config.get('signing.signer');
const signatureType = config.get('signing.signatureType');
const tradingPartnersEnabled = config.get('tradingPartnersEnabled');
const CONCURRENCY = config.get('oada.concurrency');

// Will fill in expandIndex on first job to handle
let expandIndex: {
  'trading-partners': Record<
    string,
    { id: string; facilities?: Record<string, { _id: string }> }
  >;
  'coi-holders': Record<string, {}>;
};

type Shares = Array<{
  dockey: string;
  doc: { _id: string };
  tp: { _id: string };
}>;



//------------------------------------------------------------------------------------------------------------
// - receive the job from oada-jobs

export const jobHandler: WorkerFunction = async (job, { jobId, log, oada }) => {
  trace('Received job: ', job);
  // until oada-jobs adds cross-linking, make sure we are linked under pdf's jobs
  trace('Linking job under pdf/_meta until oada-jobs can do that natively');
  await oada.put({
    path: `/bookmarks/services/target/jobs/${jobId}/config/pdf/_meta/services/target/jobs`,
    data: {
      [jobId]: { _ref: `resources/${jobId}` },
    },
  });

  // setup Expand index
  if (!expandIndex) {
    trace(`First time through, fetching expandIndex`);
    expandIndex = {
      'coi-holders': (await oada
        .get({ path: `/bookmarks/trellisfw/coi-holders/expand-index` })
        .then((r) => r.data)) as any,
      'trading-partners': (await oada
        .get({ path: `/bookmarks/trellisfw/trading-partners/expand-index` })
        .then((r) => r.data)) as any,
    };
  }

  return await new Promise(async (resolve, reject) => {
    try {
      // - once it sees "success" in the updates,
      // it will post a job to trellis-signer and notify oada-jobs of success
      const targetSuccess = async (_args?: {}) => {
        log.info(
          'helper-started',
          'Target returned success, target-helper picking up'
        );
        // turn off watches so our own updates don't keep coming to us
        try {
          await unwatch();
        } catch(err) {
          if (err.message !== 'Could not find watch state information.') throw err;
        }
        // Get the latest copy of job
        const { data: job } = await oada.get({ path: `/resources/${jobId}` });
        assertJob(job);

        const pdfid = (job.config?.pdf as { _id?: string })?._id;
        // ------------- 2: Look through all the things in result recursively,
        // if any are links then go there and set _meta/vdoc/pdf
        log.info(
          'helper: linking _meta/vdoc/pdf for each link in result',
          undefined
        );
        async function recursivePutVdocAtLinks(obj: any): Promise<void> {
          if (!obj || typeof obj !== 'object') {
            return;
          }
          if (obj._id) {
            await oada.put({
              path: `/${obj._id}/_meta`,
              data: {
                vdoc: { pdf: { _id: `${pdfid}` } },
              },
            });
            return;
          }
          for (const val of Object.values(obj)) {
            await recursivePutVdocAtLinks(val);
          }
        }
        await recursivePutVdocAtLinks(job.result);

        // ------------- 3: sign audit/coi/etc.
        log.info('helper: signing all links in result', undefined);
        async function recursiveSignLinks(obj: any): Promise<void> {
          if (!obj || typeof obj !== 'object') {
            return;
          }
          if (obj._id) {
            await signResourceForTarget({
              _id: obj._id,
              // Hack because jobs is on ancient client version
              oada: (oada as unknown) as OADAClient,
              log,
            });
            return;
          }
          for (const val of Object.values(obj)) {
            await recursiveSignLinks(val);
          }
        }
        await recursiveSignLinks(job.result);

        // ------------- 4: put audits/cois/etc. to proper home
        function recursiveMakeAllLinksVersioned(obj: any) {
          if (!obj || typeof obj !== 'object') {
            return obj;
          }
          if (obj._id) {
            return {
              _id: obj._id,
              _rev: 0,
            };
          }
          return _.reduce<any, Record<string, any>>(
            obj,
            (acc, _v, k) => {
              acc[k] = recursiveMakeAllLinksVersioned(obj[k]);
              return acc;
            },
            {}
          );
        }
        const rootPath = job['trading-partner']
          ? `/bookmarks/trellisfw/trading-partners/${job['trading-partner']}/shared/trellisfw`
          : `/bookmarks/trellisfw`;
        const versionedResult = recursiveMakeAllLinksVersioned(job.result);
        trace(`all versioned links to bookmarks = `, versionedResult);
        for (const doctype of Object.keys(versionedResult)) {
          // top-level keys are doc types
          log.info('linking', `Linking doctype ${doctype} from result`);
          // Automatically augment the base tree with the right content-type
          // @ts-ignore
          tree.bookmarks.trellisfw[doctype] = {
            _type: `application/vnd.trellis.${doctype}.1+json`,
          };
          await oada.put({
            path: `${rootPath}/${doctype}`,
            data: versionedResult[doctype],
            tree,
          });
        }

        // ------------- 1: cross link vdoc for pdf <-> audits,cois,lettters,etc.
        log.info(
          'link-refs-pdf',
          'helper: linking result _refs under <pdf>/_meta/vdoc'
        );
        function recursiveReplaceLinksWithRefs(obj: any) {
          if (!obj || typeof obj !== 'object') {
            return obj;
          }
          if (obj._id) {
            return { _ref: obj._id };
          }
          return _.reduce<any, Record<string, any>>(
            obj,
            (acc, _v, k) => {
              acc[k] = recursiveReplaceLinksWithRefs(obj[k]);
              return acc;
            },
            {}
          );
        }
        const vdoc = recursiveReplaceLinksWithRefs(job.result);
        info(
          "Linking _ref's into pdf/_meta, job.result before: %O, after: %O",
          job.result,
          vdoc
        );
        await oada.put({
          path: `/${pdfid}/_meta`,
          data: {
            // fsqa-audits { ...links... }, or fsqa-certificates { ...links... }, etc.
            vdoc,
          },
        });



        // -------------- 5: delete link from /bookmarks/trellisfw/documents now that it is identified
        if (job.config?.documentsKey) {
          log.info(
            'Unlinking from unidentified documents now that it is identified',
            undefined
          );
          info(
            'Unlinking from unidentified documents now that it is identified',
            undefined
          );
          await oada.delete({
            path: `${rootPath}/documents/${job.config.documentsKey}`,
          });
        } else {
          log.info('WARNING: Job had no documents key!', undefined);
        }

        // HARDCODED UNTIL AINZ IS UPDATED:
        // ------------- 6: lookup shares, post job to shares service
        //Only share for smithfield
        const result = job['trading-partner'] ? {} : job.result ?? {};

        for (const doctype of Object.keys(result)) {
          const shares: Shares = [];
          // Results are lists of links?
          const doclist = (job.result?.[doctype] ?? {}) as Record<
            string,
            { _id: string }
          >;
          for (const [dockey, doc] of Object.entries(doclist)) {
            trace(
              'Fetching lookups for doctype = %s, doc = %O, getting /%s/_meta/lookups',
              doctype,
              doc,
              doc._id
            );
            const { data: lookups } = ((await oada.get({
              path: `/${doc._id}/_meta/lookups`,
            })) as unknown) as {
              // TODO: WTF is a lookup??
              data: Record<string, Record<string, { _ref: string }>>;
            };
            trace('lookups = %O', lookups);
            let facilityid;
            switch (doctype) {
              case 'fsqa-audits':
                facilityid = lookups['fsqa-audit']!.organization!._ref;
                pushSharesForFacility({ facilityid, doc, dockey, shares });
                break;
              case 'fsqa-certificates':
                facilityid = lookups['fsqa-certificate']!.organization!._ref;
                pushSharesForFacility({ facilityid, doc, dockey, shares });
                break;
              case 'cois':
                const { data: holder } = ((await oada.get({
                  path: `/${lookups.coi!.holder!._ref}`,
                })) as unknown) as {
                  data: { 'trading-partners': Record<string, { _id: string }> };
                };
                trace('Retrieved holder %O', holder);
                for (const tplink of Object.values(
                  holder['trading-partners']
                )) {
                  const { data: tp } = (await oada.get({
                    path: `/${tplink._id}`,
                  })) as any;
                  shares.push({ tp, doc, dockey });
                }
                break;
              case 'letters-of-guarantee':
                const { data: buyer } = ((await oada.get({
                  path: `/${lookups['letter-of-guarantee']!.buyer!._ref}`,
                })) as unknown) as {
                  data: { 'trading-partners': Record<string, { _id: string }> };
                };
                trace('Retrieved buyer %O', buyer);
                for (const tplink of Object.values(buyer['trading-partners'])) {
                  const { data: tp } = ((await oada.get({
                    path: `/${tplink._id}`,
                  })) as unknown) as { data: { _id: string } };
                  shares.push({ tp, doc, dockey });
                }

                break;
              default:
                throw new Error(
                  'Unknown document type (' +
                    doctype +
                    ') when attempting to do lookups'
                );
            }
          }
          log.info(
            'sharing',
            `Posting ${shares.length} shares jobs for doctype ${doctype} resulting from this transcription`
          );
          for (const { dockey, doc, tp } of shares) {
            const tpkey = tp._id.replace(/^resources\//, '');
            const { data: user } = await oada.get({ path: `/${tp._id}/user` });
            // HACK FOR DEMO UNTIL WE GET MASKING SETTINGS:
            let mask: {} | boolean = false;
            if (tpkey.match(/REDDYRAW/)) {
              info('COPY WILL MASK LOCATIONS FOR REDDYRAW');
              trace(
                'pdf is only generated for fsqa-audits or cois, doctype is %s',
                doctype
              );
              mask = {
                keys_to_mask: ['location'],
                generate_pdf: doctype === 'fsqa-audits' || doctype === 'cois',
              };
            }
            // END HACK FOR DEMO
            const resid = await oada
              .post({
                path: `/resources`,
                contentType: tree.bookmarks.services['*'].jobs['*']._type,
                data: {
                  type: 'share-user-link',
                  service: 'trellis-shares',
                  config: {
                    src: `/${doc._id}`,
                    copy: {
                      // If "copy" key is not present it will link to original rather than copy
                      // copy full original as-is (rather than some subset of keys/paths).
                      // Note that this will screw up the signature if set to anything other than true.  Also, ignored if mask is truthy since original must exist unmasked.
                      original: true,
                      meta: { vdoc: true }, // copy only the vdoc path from _meta for the copy
                      mask,
                    },
                    doctype, // fsqa-audits, cois, fsqa-certificates, letters-of-guarantee
                    dest: `/bookmarks/trellisfw/${doctype}/${dockey}`, // this doubles-up bookmarks, but I think it's the most understandable to look at
                    user: user as any, // { id, bookmarks }
                    chroot: `/bookmarks/trellisfw/trading-partners/${tpkey}/user/bookmarks`,
                    tree: treeForDocType(doctype),
                  },
                },
              })
              .then((r) => r.headers['content-location']!.replace(/^\//, ''));
            const reskey = resid?.replace(/^resources\//, '');
            trace('Shares job posted as resid = %s', resid);
            const jobpath = await oada
              .put({
                path: `/bookmarks/services/trellis-shares/jobs`,
                data: { [reskey]: { _id: resid, _rev: 0 } },
                tree,
              })
              .then((r) => r.headers['content-location']);
            const jobkey = jobpath?.replace(/^\/resources\/[^\/]+\//, '');
            trace('Posted jobkey %s for shares', jobkey);
          }
        }

        log.info('done', 'Completed all helper tasks');
        return resolve(job.result as any);
      };
      const jobChange = async (c: Omit<Change, 'resource_id'>) => {
        try {
          trace('#jobChange: received change, c = %O ', c);
          // look through all the changes, only do things if it sends a "success" or "error" update status
          if (c.path !== '') {
            return false; // child
          }
          if (c.type !== 'merge') {
            return false; // delete
          }
          const { updates } = (c.body ?? {}) as {updates?: Record<string,Update>};
          if (!updates) {
            return false; // not an update from target
          }
          trace('#jobChange: it is a change we want (has an update)');
          for (const [k, v] of Object.entries<Update>(updates)) {
            const t = _.clone(v.time);
            v.time = moment(v.time).toISOString();
            if (v.time === null) {
              // @ts-ignore
              v.time = moment(t, 'X');
            }
            trace('#jobChange: change update is: %O', v);
            if (v.status === 'success') {
              trace(
                '#jobChange: unwatching job and moving on with success tasks'
              );
              await unwatch();
              // TODO: Why pass stuff to this function with no arguments?
              await targetSuccess({ update: v, key: k, change: c });
            }
            if (v.status === 'error') {
              error(
                '#jobChange: unwatching job and moving on with error tasks'
              );
              await unwatch();
              if (v.information) {
                error('Target job [%s] failed: %O', jobId, v.information);
              }
              throw new Error(
                'Target returned error: ' + JSON.stringify(v, null, '  ')
              );
            }
          }
        } catch (e) {
          reject(e);
        }
      };
      let watchhandle: string;
      const unwatch = async () => {
        await oada.unwatch(watchhandle);
      };
      const watch = async () => {
        if (watchhandle) {
          warn(
            'WARNING: watchhandle already exists, but watch() was called again'
          );
        }
        watchhandle = await oada.watch({
          path: `/bookmarks/services/target/jobs/${jobId}`,
          watchCallback: jobChange,
        });
        const { data } = await oada.get({
          path: `/bookmarks/services/target/jobs/${jobId}`,
        });
        return data;
      };
      // initially just the original job is the "body" for a synthetic change
      const w = await watch() as Change['body'];
      if (Buffer.isBuffer(w)) throw new Error('body is a buffer, cannot call jobChange')
      jobChange({
        path: '',
        body: w!,
        type: 'merge',
      });
    } catch (e) {
      reject(e);
    } // have to actually reject the promise
  });
};

async function pushSharesForFacility({
  facilityid,
  doc,
  dockey,
  shares,
}: {
  facilityid: string;
  doc: { _id: string };
  dockey: string;
  shares: Shares;
}) {
  const ei = expandIndex['trading-partners'];
  trace(
    `Looking for facility `,
    facilityid,
    ` in ${_.keys(ei).length} trading partners`
  );
  for (const tpv of Object.values(ei)) {
    if (!tpv.facilities) {
      return; // tp has no facilities
    }
    if (!_.find(tpv.facilities, (flink) => flink._id === facilityid)) {
      return; // have facilities, just not this one
    }
    // Do we need this cloneDeep?
    const { id, ...tp } = _.cloneDeep(tpv);
    const s = { tp: { _id: id, ...tp }, doc, dockey };
    shares.push(s);
    trace('Added share to running list: %O', s);
  }
}

async function signResourceForTarget({
  _id,
  oada,
  log,
}: {
  _id: string;
  oada: OADAClient;
  log: Logger;
}) {
  let { data: a } = (await oada.get({ path: `/${_id}` })) as { data: any };
  //const { data: r } = await oada.get({ path: `/${_id}` });
  //const a = _.cloneDeep(r); // the actual audit or coi json

  try {
    // Test first if this thing already has a transcription signature.  If so, skip it.
    trace('#signResourceForTarget: Checking for existing signature...');
    async function hasTranscriptionSignature(res: {
      signatures?: {};
    }): Promise<boolean> {
      if (!res.signatures) {
        return false;
      }
      const {
        trusted,
        valid,
        unchanged,
        payload,
        original,
      } = await tsig.verify(res);
      trace(
        '#signResourceForTarget: Checked for signature, got back trusted %s valid %s unchanged %s payload %O',
        trusted,
        valid,
        unchanged,
        payload
      );
      if (payload?.type === signatureType) {
        return true; // Found one!
      }
      if (original) {
        return await hasTranscriptionSignature(original);
      }
      return false; // shouldn't ever get here.
    }
    if (await hasTranscriptionSignature(a)) {
      log.error(
        `#signResourceForTarget: Item ${_id} already has a transcription signature on it, choose to skip it and not apply a new one`,
        undefined
      );
      return true;
    }
    trace(
      '#signResourceForTarget: Did not find existing %s signature, signing...',
      signatureType
    );

    // Otherwise, go ahead and apply the signature
    a = await tsig.sign(a, prvKey, { header, signer, type: signatureType });
  } catch (e) {
    error('Could not apply signature to resource %s, err = %O', _id, e);
    throw new Error(`Could not apply signature to resource ${_id}`);
  }

  info('PUTing signed signatures key only to /%s/signatures', _id);
  await oada
    .put({ path: `/${_id}/signatures`, data: a.signatures })
    .catch((e) => {
      error(`Failed to apply signature to /${_id}/signatures, error = `, e);
      throw new Error(`Failed to apply signature to /${_id}/signatures`);
    });
  log.info('signed', `Signed resource ${_id} successfully`);
  return true; // success!
}

function treeForDocType(doctype: string) {
  let singularType = doctype;
  if (singularType.match(/s$/)) {
    // if it ends in 's', easy fix
    singularType = singularType.replace(/s$/, '');
  } else if (singularType.match(/-/)) {
    // if it has a dash, maybe it is like letters-of-guarantee (first thing plural)
    const parts = singularType.split('-');
    if (parts[0]?.match(/s$/)) {
      parts[0] = parts[0].replace(/s$/, '');
    } else {
      throw new Error(
        `ERROR: doctype ${doctype} has dashes, but is not easily convertible to singular word for _type`
      );
    }
    singularType = parts.join('-');
  } else {
    throw new Error(
      `ERROR: doctype ${doctype} is not easily convertible to singular word for _type`
    );
  }
  return {
    bookmarks: {
      _type: 'application/vnd.oada.bookmarks.1+json',
      trellisfw: {
        _type: 'application/vnd.trellis.1+json',
        [doctype]: {
          // cois, fsqa-audits, etc.
          '_type': `application/vnd.trellis.${doctype}.1+json`, // plural word: cois, letters-of-guarantee
          '*': {
            _type: `application/vnd.trellis.${singularType}.1+json`, // coi, letter-of-guarantee
            _rev: 1, // links within each type of thing are versioned
          },
        },
      },
    },
  };
}

//-------------------------------------------------------------------------------------------------------
// Start watching /bookmarks/trellisfw/documents and create target jobs for each new one
export async function startJobCreator({
  domain,
  token,
}: {
  domain: string;
  token: string;
}) {
  try {
    info(`Connecting to client with concurrency ${CONCURRENCY}`);
    const con = await connect({ domain, token, concurrency: CONCURRENCY });

    await cleanupBrokenLinks();
    setInterval(cleanupBrokenLinks, 600000);

    let tp_exists = await con
      .get({ path: `/bookmarks/trellisfw/trading-partners` })
      .catch((e) => e);
    if (tp_exists.status !== 200) {
      info(
        `/bookmarks/trellisfw/trading-partners does not exist, creating....`
      );
      await con.put({
        path: '/bookmarks/trellisfw/trading-partners',
        data: {},
        tree,
      });
      tp_exists = {data: {}}
    }

    trace('Trading partners enabled %s', tradingPartnersEnabled);
    if (tradingPartnersEnabled) {
      new ListWatch({
        path: `/bookmarks/trellisfw/trading-partners`,
        name: `target-helper-trading-partners`,
        conn: con,
        resume: false,
        onAddItem: watchTp,
      })
    }

    // ensure the documents endpoint exists because Target is an enabler of that endpoint
    const exists = await con
      .get({ path: `/bookmarks/trellisfw/documents` })
      .then((r) => r.status)
      .catch((e) => e.status);
    if (exists !== 200) {
      info('/bookmarks/trellisfw/documents does not exist, creating...');
      await con.put({ path: '/bookmarks/trellisfw/documents', data: {}, tree });
    }

    const func = documentAdded();
    new ListWatch({
      path: `/bookmarks/trellisfw/documents`,
      name: `TARGET-SF-docs`,
      conn: con,
      resume: true,
      onNewList: ListWatch.AssumeHandled,
      onAddItem: func,
    });

    async function cleanupBrokenLinks() {
      const jobs = (await con.get({
        path: `/bookmarks/services/target/jobs`,
      }).then(r => r.data) || {}) as Jobs;
      let jobids = Object.keys(jobs).filter(key => key.charAt(0) !== '_')
      let count = 0;

      await bPromise.map(jobids, async (jobid:string) => {
        let job = jobs[jobid]!;

        if (Object.keys(job).length === 1 && job._rev) {
          count++;
          info(`cleaning up broken job /bookmarks/services/target/jobs/${jobid}`)
          await con.delete({
            path: `/bookmarks/services/target/jobs/${jobid}`,
          })
        }
      })
      info(`Done cleaning up ${count} target jobs`);

    }

    async function watchTp(_: unknown, key: string) {
      key = key.replace(/^\//, '');
      info(`New trading partner detected at key: [${key}]`);
      const path = `/bookmarks/trellisfw/trading-partners/${key}/shared/trellisfw/documents`;
      info('Starting listwatch on %s', path);
      const tp_exist = await con.head({ path }).catch((e) => e);
      if (tp_exist.status !== 200) {
        info('%s does not exist, creating....', path);
        await con.put({
          path,
          data: {},
          tree,
        });
      }
      const func = documentAdded(key);
      new ListWatch({
        path,
        name: `target-helper-tp-docs`,
        onNewList: ListWatch.AssumeHandled,
        conn: con,
        resume: true,
        onAddItem: func,
      });
    }

    function documentAdded(tp?: string) {
      return async function (item: { _id: string }, key: string) {
        try {
          // bugfix leading slash that sometimes appears in key
          key = key.replace(/^\//, '');
          info('New Document posted at key = %s', key);
          // Get the _id for the actual PDF
          /* instead of POSTing, it now just PUTs with a known _id
          const docid = await con
            .get({
              path: tp
                ? `bookmarks/trellisfw/trading-partners/${tp}/shared/trellisfw/documents`
                : `/bookmarks/trellisfw/documents`,
            })
            // Hack: have to get the whole list,
            // then get the link for this key in order to figure out the _id at the moment.
            .then((r) => (r.data as any)[key])
            .then((l) => l?._id ?? false);
           */

          const jobkey = await con
            .post({
              path: '/resources',
              contentType: 'application/vnd.oada.job.1+json',
              data: {
                'trading-partner': tp,
                'type': 'transcription',
                'service': 'target',
                'config': {
                  type: 'pdf',
                  pdf: { _id: key },
                  documentsKey: key,
                },
              } as any,
            })
            .then((r) =>
              r.headers['content-location']!.replace(/^\/resources\//, '')
            )
            .catch((e) => {
              throw oerror.tag(
                e,
                'Failed to create new job resource for item ',
                item._id
              );
            });

          await con
            .put({
              path: `/bookmarks/services/target/jobs`,
              tree,
              data: {
                [jobkey]: { _id: `resources/${jobkey}`, _rev: 0 },
              },
            })
            .catch((e) => {
              throw oerror.tag(
                e,
                'Failed to PUT job link under target job queue for job key ',
                jobkey
              );
            });
          info('Posted job resource, jobkey = %s', jobkey);
        } catch (err) {
          error(err);
        }
      };
    }
  } catch (e) {
    oerror.tag(e, 'ListWatch failed!');
    throw e;
  }
}


