/**
 * @license
 *  Copyright 2021 Qlever LLC
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

import { readFileSync } from 'node:fs';

import _ from 'lodash';
import debug from 'debug';
import moment from 'moment';
import oError from '@overleaf/o-error';

import { Change, OADAClient, connect } from '@oada/client';
import type { Json, Logger, WorkerFunction } from '@oada/jobs';
import type Jobs from '@oada/types/oada/service/jobs';
import { ListWatch } from '@oada/list-lib';
import type Update from '@oada/types/oada/service/job/update';
import { assert as assertJob } from '@oada/types/oada/service/job.js';
// @ts-expect-error too lazy to figure out types
import tSignatures from '@trellisfw/signatures';

import config from './config.js';
import tree from './tree.js';

const error = debug('target-helper:error');
const warn = debug('target-helper:warn');
const info = debug('target-helper:info');
const trace = debug('target-helper:trace');

// You can generate a signing key pair by running `oada-certs --create-keys`
const prvKey = JSON.parse(
  readFileSync(config.get('signing.privateJWK')).toString()
) as { jku?: string; kid?: string; kty?: string; n?: string; e?: string };
// eslint-disable-next-line @typescript-eslint/no-unsafe-call
const pubKey = tSignatures.keys.pubFromPriv(prvKey) as Record<string, unknown>;
const header: { jwk: Record<string, unknown>; jku?: string; kid?: string } = {
  jwk: pubKey,
};
if (prvKey.jku) {
  header.jku = prvKey.jku; // Make sure we keep jku and kid
}

if (prvKey.kid) {
  header.kid = prvKey.kid;
}

const signer = config.get('signing.signer');
const signatureType = config.get('signing.signatureType');
const tradingPartnersEnabled = config.get('tradingPartnersEnabled');
const CONCURRENCY = config.get('oada.concurrency');
const TP_MPATH = `/bookmarks/trellisfw/trading-partners/masterid-index`;

// Will fill in expandIndex on first job to handle
let expandIndex: {
  // eslint-disable-next-line sonarjs/no-duplicate-string
  'trading-partners': Record<
    string,
    { id: string; facilities?: Record<string, { _id: string }> }
  >;
  'coi-holders': Record<string, Record<string, unknown>>;
};

type Shares = Array<{
  dockey: string;
  doc: { _id: string };
  tp: { _id: string };
}>;

// ------------------------------------------------------------------------------------------------------------
// - receive the job from oada-jobs

export const jobHandler: WorkerFunction = async (job, { jobId, log, oada }) => {
  trace('Received job: ', job);
  // Until oada-jobs adds cross-linking, make sure we are linked under pdf's jobs
  trace('Linking job under pdf/_meta until oada-jobs can do that natively');
  await oada.put({
    path: `/bookmarks/services/target/jobs/${jobId}/config/pdf/_meta/services/target/jobs`,
    data: {
      [jobId]: { _ref: `resources/${jobId}` },
    },
  });

  // Setup Expand index
  if (!expandIndex) {
    trace(`First time through, fetching expandIndex`);
    expandIndex = {
      'coi-holders': (
        await oada.get({
          path: `/bookmarks/trellisfw/coi-holders/expand-index`,
        })
      ).data as Record<string, Record<string, unknown>>,
      'trading-partners': (
        await oada.get({
          path: `/bookmarks/trellisfw/trading-partners/expand-index`,
        })
      ).data as Record<
        string,
        { id: string; facilities?: Record<string, { _id: string }> }
      >,
    };
  }

  return new Promise(async (resolve, reject) => {
    try {
      // - once it sees "success" in the updates,
      // it will post a job to trellis-signer and notify oada-jobs of success
      const targetSuccess = async (_arguments?: Record<string, unknown>) => {
        void log.info(
          'helper-started',
          'Target returned success, target-helper picking up'
        );
        // Turn off watches so our own updates don't keep coming to us
        try {
          await unwatch();
        } catch (cError: unknown) {
          if (
            (cError as Error).message !==
            'Could not find watch state information.'
          )
            throw cError;
        }

        // Get the latest copy of job
        const { data: job } = await oada.get({ path: `/resources/${jobId}` });
        assertJob(job);

        const pdfID = (job.config?.pdf as { _id?: string })?._id;
        // ------------- 2: Look through all the things in result recursively,
        // if any are links then go there and set _meta/vdoc/pdf
        void log.info(
          'helper: linking _meta/vdoc/pdf for each link in result',
          {}
        );
        async function recursivePutVdocAtLinks(object: unknown): Promise<void> {
          if (typeof object !== 'object' || !object) {
            return;
          }

          if ('_id' in object) {
            await oada.put({
              // @ts-expect-error --- we know it has _id
              path: `/${object._id}/_meta`,
              data: {
                vdoc: { pdf: { _id: `${pdfID}` } },
              },
            });
            return;
          }

          for (const value of Object.values(object)) {
            // eslint-disable-next-line no-await-in-loop
            await recursivePutVdocAtLinks(value);
          }
        }

        await recursivePutVdocAtLinks(job.result);

        // ------------- 3: sign audit/coi/etc.
        void log.info('helper: signing all links in result', {});
        async function recursiveSignLinks(object: unknown): Promise<void> {
          if (typeof object !== 'object' || !object) {
            return;
          }

          if ('_id' in object) {
            await signResourceForTarget({
              // @ts-expect-error --- we know it has _id
              _id: object._id as string,
              // Hack because jobs is on ancient client version
              oada: oada as unknown as OADAClient,
              log,
            });
            return;
          }

          for (const value of Object.values(object)) {
            // eslint-disable-next-line no-await-in-loop
            await recursiveSignLinks(value);
          }
        }

        await recursiveSignLinks(job.result);

        // ------------- 4: put audits/cois/etc. to proper home
        function recursiveMakeAllLinksVersioned(object: unknown) {
          if (typeof object !== 'object' || !object) {
            return object;
          }

          if ('_id' in object) {
            return {
              // @ts-expect-error --- we know it has _id
              _id: object._id as string,
              _rev: 0,
            };
          }

          return _.reduce<any, Record<string, any>>(
            object,
            (accumulator, _v, k) => {
              accumulator[k] = recursiveMakeAllLinksVersioned(
                (object as Record<string, unknown>)[k]
              );
              return accumulator;
            },
            {}
          );
        }

        const rootPath = job['trading-partner']
          ? `${TP_MPATH}/${job['trading-partner']}/shared/trellisfw`
          : `/bookmarks/trellisfw`;
        const versionedResult = recursiveMakeAllLinksVersioned(
          job.result
        ) as Record<string, unknown>;
        trace(`all versioned links to bookmarks = `, versionedResult);
        for (const doctype of Object.keys(versionedResult)) {
          // Top-level keys are doc types
          void log.info('linking', `Linking doctype ${doctype} from result`);
          // Automatically augment the base tree with the right content-type
          // @ts-expect-error
          tree.bookmarks.trellisfw[doctype] = {
            _type: `application/vnd.trellis.${doctype}.1+json`,
          };
          // eslint-disable-next-line no-await-in-loop
          await oada.put({
            path: `${rootPath}/${doctype}`,
            data: versionedResult[doctype] as Json,
            tree,
          });
        }

        // ------------- 1: cross link vdoc for pdf <-> audits,cois,letters,etc.
        void log.info(
          'link-refs-pdf',
          'helper: linking result _refs under <pdf>/_meta/vdoc'
        );
        function recursiveReplaceLinksWithReferences(object: unknown) {
          if (typeof object !== 'object' || !object) {
            return object;
          }

          if ('_id' in object) {
            // @ts-expect-error --- we know it has _id
            return { _ref: object._id as string };
          }

          return _.reduce<any, Record<string, any>>(
            object,
            (accumulator, _v, k) => {
              accumulator[k] = recursiveReplaceLinksWithReferences(
                (object as Record<string, unknown>)[k]
              );
              return accumulator;
            },
            {}
          );
        }

        const vdoc = recursiveReplaceLinksWithReferences(job.result);
        info(
          "Linking _ref's into pdf/_meta, job.result before: %O, after: %O",
          job.result,
          vdoc
        );
        await oada.put({
          path: `/${pdfID}/_meta`,
          data: {
            // Fsqa-audits { ...links... }, or fsqa-certificates { ...links... }, etc.
            vdoc: vdoc as Json,
          },
        });

        // -------------- 5: delete link from /bookmarks/trellisfw/documents now that it is identified
        if (job.config?.documentsKey) {
          void log.info(
            'Unlinking from unidentified documents now that it is identified',
            {}
          );
          info(
            'Unlinking from unidentified documents now that it is identified'
          );
          await oada.delete({
            path: `${rootPath}/documents/${job.config.documentsKey}`,
          });
        } else {
          void log.info('WARNING: Job had no documents key!', {});
        }

        // HARDCODED UNTIL AINZ IS UPDATED:
        // ------------- 6: lookup shares, post job to shares service
        // Only share for smithfield
        const result = job['trading-partner'] ? {} : job.result ?? {};

        for (const doctype of Object.keys(result)) {
          const shares: Shares = [];
          // Results are lists of links?
          const doclist = (job.result?.[doctype] ?? {}) as Record<
            string,
            { _id: string }
          >;
          for (const [dockey, document] of Object.entries(doclist)) {
            trace(
              'Fetching lookups for doctype = %s, doc = %O, getting /%s/_meta/lookups',
              doctype,
              document,
              document._id
            );
            // eslint-disable-next-line no-await-in-loop
            const { data: lookups } = (await oada.get({
              path: `/${document._id}/_meta/lookups`,
            })) as unknown as {
              // TODO: WTF is a lookup??
              data: Record<string, Record<string, { _ref: string }>>;
            };
            trace('lookups = %O', lookups);
            let facilityID;
            switch (doctype) {
              case 'fsqa-audits':
                facilityID = lookups['fsqa-audit']!.organization!._ref;
                // eslint-disable-next-line no-await-in-loop
                await pushSharesForFacility({
                  facilityid: facilityID,
                  doc: document,
                  dockey,
                  shares,
                });
                break;
              case 'fsqa-certificates':
                facilityID = lookups['fsqa-certificate']!.organization!._ref;
                // eslint-disable-next-line no-await-in-loop
                await pushSharesForFacility({
                  facilityid: facilityID,
                  doc: document,
                  dockey,
                  shares,
                });
                break;
              case 'cois':
                // eslint-disable-next-line no-await-in-loop
                const { data: holder } = (await oada.get({
                  path: `/${lookups.coi!.holder!._ref}`,
                })) as unknown as {
                  data: { 'trading-partners': Record<string, { _id: string }> };
                };
                trace('Retrieved holder %O', holder);
                for (const tpLink of Object.values(
                  holder['trading-partners']
                )) {
                  // eslint-disable-next-line no-await-in-loop
                  const { data: tp } = (await oada.get({
                    path: `/${tpLink._id}`,
                  })) as any;
                  shares.push({ tp, doc: document, dockey });
                }

                break;
              case 'letters-of-guarantee':
                // eslint-disable-next-line no-await-in-loop
                const { data: buyer } = (await oada.get({
                  path: `/${lookups['letter-of-guarantee']!.buyer!._ref}`,
                })) as unknown as {
                  data: { 'trading-partners': Record<string, { _id: string }> };
                };
                trace('Retrieved buyer %O', buyer);
                for (const tpLink of Object.values(buyer['trading-partners'])) {
                  // eslint-disable-next-line no-await-in-loop
                  const { data: tp } = (await oada.get({
                    path: `/${tpLink._id}`,
                  })) as unknown as { data: { _id: string } };
                  shares.push({ tp, doc: document, dockey });
                }

                break;
              default:
                throw new Error(
                  `Unknown document type (${doctype}) when attempting to do lookups`
                );
            }
          }

          void log.info(
            'sharing',
            `Posting ${shares.length} shares jobs for doctype ${doctype} resulting from this transcription`
          );
          for (const { dockey, doc, tp } of shares) {
            const tpkey = tp._id.replace(/^resources\//, '');
            // eslint-disable-next-line no-await-in-loop
            const { data: user } = await oada.get({ path: `/${tp._id}/user` });
            if (Buffer.isBuffer(user)) {
              throw new TypeError('user was not JSON');
            }

            // HACK FOR DEMO UNTIL WE GET MASKING SETTINGS:
            let mask:
              | { keys_to_mask: string[]; generate_pdf: boolean }
              | boolean = false;
            if (tpkey.includes('REDDYRAW')) {
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
            // eslint-disable-next-line no-await-in-loop
            const resourceID = await oada
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
                      meta: { vdoc: true }, // Copy only the vdoc path from _meta for the copy
                      mask,
                    },
                    doctype, // Fsqa-audits, cois, fsqa-certificates, letters-of-guarantee
                    dest: `/bookmarks/trellisfw/${doctype}/${dockey}`, // This doubles-up bookmarks, but I think it's the most understandable to look at
                    user, // { id, bookmarks }
                    chroot: `/bookmarks/trellisfw/trading-partners/${tpkey}/user/bookmarks`,
                    tree: treeForDocumentType(doctype),
                  },
                },
              })
              .then((r) => r.headers['content-location']!.replace(/^\//, ''));
            const reskey = resourceID?.replace(/^resources\//, '');
            trace('Shares job posted as resid = %s', resourceID);
            // eslint-disable-next-line no-await-in-loop
            const jobpath = await oada
              .put({
                path: `/bookmarks/services/trellis-shares/jobs`,
                data: { [reskey]: { _id: resourceID, _rev: 0 } },
                tree,
              })
              .then((r) => r.headers['content-location']);
            const jobkey = jobpath?.replace(/^\/resources\/[^/]+\//, '');
            trace('Posted jobkey %s for shares', jobkey);
          }
        }

        void log.info('done', 'Completed all helper tasks');
        resolve(job.result as any);
      };

      const jobChange = async (c: Omit<Change, 'resource_id'>) => {
        try {
          trace('#jobChange: received change, c = %O ', c);
          // Look through all the changes, only do things if it sends a "success" or "error" update status
          if (c.path !== '') {
            return; // Child
          }

          if (c.type !== 'merge') {
            return; // Delete
          }

          const { updates } = (c.body ?? {}) as {
            updates?: Record<string, Update>;
          };
          if (!updates) {
            return; // Not an update from target
          }

          trace('#jobChange: it is a change we want (has an update)');
          for (const [k, v] of Object.entries(updates)) {
            const t = _.clone(v.time);
            v.time = moment(v.time).toISOString();
            if (v.time === null) {
              // @ts-expect-error --- ?
              v.time = moment(t, 'X');
            }

            trace(v, '#jobChange: change update');
            if (v.status === 'success') {
              trace(
                '#jobChange: unwatching job and moving on with success tasks'
              );
              // eslint-disable-next-line no-await-in-loop
              await unwatch();
              // TODO: Why pass stuff to this function with no arguments?
              // eslint-disable-next-line no-await-in-loop
              await targetSuccess({ update: v, key: k, change: c });
            }

            if (v.status === 'error') {
              error(
                '#jobChange: unwatching job and moving on with error tasks'
              );
              // eslint-disable-next-line no-await-in-loop
              await unwatch();
              if (v.information) {
                error('Target job [%s] failed: %O', jobId, v.information);
              }

              throw new Error(
                `Target returned error: ${JSON.stringify(v, undefined, '  ')}`
              );
            }
          }
        } catch (cError: unknown) {
          reject(cError);
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

        // eslint-disable-next-line security/detect-non-literal-fs-filename
        watchhandle = await oada.watch({
          path: `/bookmarks/services/target/jobs/${jobId}`,
          watchCallback: jobChange,
        });
        const { data } = await oada.get({
          path: `/bookmarks/services/target/jobs/${jobId}`,
        });
        return data;
      };

      // Initially just the original job is the "body" for a synthetic change
      const w = (await watch()) as Change['body'];
      if (Buffer.isBuffer(w)) {
        throw new TypeError('body is a buffer, cannot call jobChange');
      }

      await jobChange({
        path: '',
        body: w,
        type: 'merge',
      });
    } catch (cError: unknown) {
      reject(cError);
    } // Have to actually reject the promise
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
      return; // Tp has no facilities
    }

    if (!_.some(tpv.facilities, (fLink) => fLink._id === facilityid)) {
      return; // Have facilities, just not this one
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
  // Const { data: r } = await oada.get({ path: `/${_id}` });
  // const a = _.cloneDeep(r); // the actual audit or coi json

  try {
    // Test first if this thing already has a transcription signature.  If so, skip it.
    trace('#signResourceForTarget: Checking for existing signature...');
    // eslint-disable-next-line no-inner-declarations
    async function hasTranscriptionSignature(resource: {
      signatures?: Record<string, unknown>;
    }): Promise<boolean> {
      if (!resource.signatures) {
        return false;
      }

      const { trusted, valid, unchanged, payload, original } =
        await tSignatures.verify(resource);
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
        return hasTranscriptionSignature(original);
      }

      return false; // Shouldn't ever get here.
    }

    if (await hasTranscriptionSignature(a)) {
      void log.error(
        `#signResourceForTarget: Item ${_id} already has a transcription signature on it, choose to skip it and not apply a new one`,
        {}
      );
      return true;
    }

    trace(
      '#signResourceForTarget: Did not find existing %s signature, signing...',
      signatureType
    );

    // Otherwise, go ahead and apply the signature
    a = await tSignatures.sign(a, prvKey, {
      header,
      signer,
      type: signatureType,
    });
  } catch (cError: unknown) {
    error(cError, `Could not apply signature to resource ${_id}`);
    throw new Error(`Could not apply signature to resource ${_id}`);
  }

  info('PUTing signed signatures key only to /%s/signatures', _id);
  try {
    await oada.put({ path: `/${_id}/signatures`, data: a.signatures });
  } catch (cError: unknown) {
    error(cError, `Failed to apply signature to /${_id}/signatures`);
    throw new Error(`Failed to apply signature to /${_id}/signatures`);
  }

  void log.info('signed', `Signed resource ${_id} successfully`);
  return true; // Success!
}

function treeForDocumentType(doctype: string) {
  let singularType = doctype;
  if (singularType.endsWith('s')) {
    // If it ends in 's', easy fix
    singularType = singularType.replace(/s$/, '');
  } else if (singularType.includes('-')) {
    // If it has a dash, maybe it is like letters-of-guarantee (first thing plural)
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
          // Cois, fsqa-audits, etc.
          '_type': `application/vnd.trellis.${doctype}.1+json`, // Plural word: cois, letters-of-guarantee
          '*': {
            _type: `application/vnd.trellis.${singularType}.1+json`, // Coi, letter-of-guarantee
            _rev: 1, // Links within each type of thing are versioned
          },
        },
      },
    },
  };
}

// -------------------------------------------------------------------------------------------------------
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
    setInterval(cleanupBrokenLinks, 600_000);

    await con
      .head({ path: `/bookmarks/trellisfw/trading-partners` })
      .catch(async (cError) => {
        if (cError.status !== 200) {
          info(
            `/bookmarks/trellisfw/trading-partners does not exist, creating....`
          );
          await con.put({
            path: '/bookmarks/trellisfw/trading-partners',
            data: {},
            tree,
          });
        }
      });

    await con
      .head({ path: `/bookmarks/trellisfw/coi-holders` })
      .catch(async (cError) => {
        if (cError.status === 404) {
          info(`/bookmarks/trellisfw/coi-holders does not exist, creating....`);
          await con.put({
            path: '/bookmarks/trellisfw/coi-holders',
            data: {},
            tree,
          });

          await con.put({
            path: '/bookmarks/trellisfw/coi-holders/expand-index',
            data: {},
            tree,
          });
        }
      });

    trace('Trading partners enabled %s', tradingPartnersEnabled);
    if (tradingPartnersEnabled) {
      // eslint-disable-next-line no-new
      new ListWatch({
        path: TP_MPATH,
        name: `target-helper-trading-partners`,
        conn: con,
        resume: false,
        onAddItem: watchTp,
      });
    }

    // Ensure the documents endpoint exists because Target is an enabler of that endpoint
    const exists = await con
      .get({ path: `/bookmarks/trellisfw/documents` })
      .then((r) => r.status)
      .catch((cError) => cError.status);
    if (exists !== 200) {
      info('/bookmarks/trellisfw/documents does not exist, creating...');
      await con.put({ path: '/bookmarks/trellisfw/documents', data: {}, tree });
    }

    const function_ = documentAdded();
    // eslint-disable-next-line no-new
    new ListWatch({
      path: `/bookmarks/trellisfw/documents`,
      name: `TARGET-SF-docs`,
      conn: con,
      resume: true,
      onNewList: ListWatch.AssumeHandled,
      onAddItem: function_,
    });

    // eslint-disable-next-line no-inner-declarations
    async function cleanupBrokenLinks() {
      const jobs = ((await con
        .get({
          path: `/bookmarks/services/target/jobs`,
        })
        .then((r) => r.data)) ?? {}) as Jobs;
      const jobids = Object.keys(jobs).filter((key) => !key.startsWith('_'));
      let count = 0;

      await Promise.all(
        jobids.map(async (jodi: string) => {
          const job = jobs[jodi]!;

          if (Object.keys(job).length === 1 && job._rev) {
            count++;
            info(
              `cleaning up broken job /bookmarks/services/target/jobs/${jodi}`
            );
            await con.delete({
              path: `/bookmarks/services/target/jobs/${jodi}`,
            });
          }
        })
      );
      info(`Done cleaning up ${count} target jobs`);
    }

    // eslint-disable-next-line no-inner-declarations
    async function watchTp(_: unknown, key: string) {
      key = key.replace(/^\//, '');
      info(`New trading partner detected at key: [${key}]`);
      const path = `${TP_MPATH}/${key}/shared/trellisfw/documents`;
      info('Starting listwatch on %s', path);
      const tp_exist = await con.head({ path }).catch((cError) => cError);
      if (tp_exist.status !== 200) {
        info('%s does not exist, creating....', path);
        await con.put({
          path,
          data: {},
          tree,
        });
      }

      const function_ = documentAdded(key);
      // eslint-disable-next-line no-new
      new ListWatch({
        path,
        name: `target-helper-tp-docs`,
        onNewList: ListWatch.AssumeHandled,
        conn: con,
        resume: true,
        onAddItem: function_,
      });
    }

    // eslint-disable-next-line no-inner-declarations
    function documentAdded(tp?: string) {
      return async function (item: { _id: string }, key: string) {
        try {
          // Bugfix leading slash that sometimes appears in key
          key = key.replace(/^\//, '');
          info('New Document posted at key = %s', key);
          if (tp) info('New Document posted for tp = %s', tp);
          // Get the _id for the actual PDF
          /* instead of POSTing, it now just PUTs with a known _id
          const docid = await con
            .get({
              path: tp
                ? `${TP_MPATH}/${tp}/shared/trellisfw/documents`
                : `/bookmarks/trellisfw/documents`,
            })
            // Hack: have to get the whole list,
            // then get the link for this key in order to figure out the _id at the moment.
            .then((r) => (r.data as any)[key])
            .then((l) => l?._id ?? false);
           */
          const documentID = `resources/${key}`;

          try {
            const { headers } = await con.post({
              path: '/resources',
              contentType: 'application/vnd.oada.job.1+json',
              data: {
                'trading-partner': tp,
                'type': 'transcription',
                'service': 'target',
                'config': {
                  type: 'pdf',
                  pdf: { _id: documentID },
                  documentsKey: key,
                },
              },
            });
            const jobkey = headers['content-location']!.replace(
              /^\/resources\//,
              ''
            );

            info('Posted job resource, jobkey = %s', jobkey);
            try {
              await con.put({
                path: `/bookmarks/services/target/jobs`,
                tree,
                data: {
                  [jobkey]: { _id: `resources/${jobkey}`, _rev: 0 },
                },
              });
              trace('Posted new PDF document to target task queue');
            } catch (cError: unknown) {
              throw oError.tag(
                cError as Error,
                'Failed to PUT job link under target job queue for job key ',
                jobkey
              );
            }
          } catch (cError: unknown) {
            throw oError.tag(
              cError as Error,
              'Failed to create new job resource for item ',
              item._id
            );
          }
        } catch (cError: unknown) {
          error(cError);
        }
      };
    }
  } catch (cError: unknown) {
    oError.tag(cError as Error, 'ListWatch failed!');
    throw cError;
  }
}
