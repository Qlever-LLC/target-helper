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

import { readFile } from 'node:fs/promises';

import clone from 'clone-deep';
import debug from 'debug';
import moment from 'moment';
import pointer from 'jsonpointer';
import oError from '@overleaf/o-error';

import { Change, OADAClient, connect } from '@oada/client';
import type { Json, Logger, WorkerFunction } from '@oada/jobs';
import tSignatures, { JWK } from '@trellisfw/signatures';
import type Jobs from '@oada/types/oada/service/jobs.js';
import { ListWatch } from '@oada/list-lib';
import type Update from '@oada/types/oada/service/job/update.js';
import { assert as assertJob } from '@oada/types/oada/service/job.js';

import tree, { TreeKey } from './tree.js';
import config from './config.js';
import {fromOadaType} from './conversions.js';

const error = debug('target-helper:error');
const info = debug('target-helper:info');
const trace = debug('target-helper:trace');

const pending = `/bookmarks/services/target/jobs/pending`;

/**
 * Helper because TS is dumb and doesn't realize `in` means the key definitely exists.
 */
function has<T, K extends string>(
  value: T,
  key: K
): value is T & { [P in K]: unknown } {
  return value && key in value;
}

// You can generate a signing key pair by running `oada-certs --create-keys`
const keyFile = await readFile(config.get('signing.privateJWK'));
const prvKey = JSON.parse(keyFile.toString()) as JWK;
const pubKey = await tSignatures.keys.pubFromPriv(prvKey);
const header: { jwk: JWK; jku?: string; kid?: string } = {
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
const TP_MASTER_PATH = `/bookmarks/trellisfw/trading-partners/masterid-index`;

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

function recursiveMakeAllLinksVersioned(object: unknown): unknown {
  if (typeof object !== 'object' || !object) {
    return object;
  }

  if (has(object, '_id')) {
    return {
      _id: object._id as string,
      _rev: 0,
    };
  }

  return Object.fromEntries(
    Object.entries(object).map(([key, value]) => [
      key,
      recursiveMakeAllLinksVersioned(value),
    ])
  );
}

function recursiveReplaceLinksWithReferences(object: unknown): unknown {
  if (typeof object !== 'object' || !object) {
    return object;
  }

  if (has(object, '_id')) {
    return { _ref: object._id as string };
  }

  return Object.fromEntries(
    Object.entries(object).map(([key, value]) => [
      key,
      recursiveReplaceLinksWithReferences(value),
    ])
  );
}

// ----------------------------------------------------------------------------
// - receive the job from oada-jobs

export const jobHandler: WorkerFunction = async (job, { jobId, log, oada }) => {
  trace('Received job: ', job);
  // Until oada-jobs adds cross-linking, make sure we are linked under the PDF's jobs
  trace('Linking job under pdf/_meta until oada-jobs can do that natively');
  //TODO: This seems broken when it writes to the target job
  await oada.put({
    path: `${pending}/${jobId}/config/pdf/_meta/services/target/jobs`,
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
      const targetSuccess = async (_arguments?: unknown) => {
        void log.info(
          'helper-started',
          'Target returned success, target-helper picking up'
        );

        // Get the latest copy of job
        // eslint-disable-next-line @typescript-eslint/no-shadow
        const { data: job } = await oada.get({ path: `/resources/${jobId}` });
        assertJob(job);

        const pdfID = (job.config?.pdf as { _id?: string })?._id;

        // ------------- 0: Construct the result from the targetResult
        // If/when a result that matches the input partial json is found,
        // merge the resource created by target into the partial json.
        // Do this all first and store it as the result for the remaining steps
        // to use.
        job.result = {};

        // Track whether the partial JSON was ammended.
        let wroteToDocument = false;
        //@ts-ignore
        for (const [doctype, data] of Object.entries(job.targetResult)) {
          job!.result![doctype] = {};
          //@ts-ignore
          for (const [docKey, docData] of Object.entries(data)) {
            //@ts-ignore
            let resultId = docData._id;
            let oDocType = job!.config!["oada-doc-type"];
          //@ts-ignore
            if (oDocType === doctype && !wroteToDocument) {
              wroteToDocument = true;
              let docId = (job!.config!.document as any)._id;
              info(`Found a result of the same type as partial Json: ${doctype}. Merging from ${resultId} to ${docId}.`);
              let merge = await oada.get({
                path: resultId
              }).then(r => Object.fromEntries(Object.entries(r.data || {}).filter(([key]) => key.charAt(0) !== '_')))

              await oada.put({
                path: docId,
                data: merge as Json,
              })
              //@ts-ignore
              job!.result![doctype][job!.config!.docKey] = { _id: docId }
            } else {
              //@ts-ignore
              job!.result![doctype][docKey] = job.targetResult[doctype][docKey];
              info(`Result doctype [${doctype}] did not match partial Json: ${oDocType}. Linking into list ${resultId}.`);
            }
          }
        }
        // No results matched the existing partial JSON
        if (!wroteToDocument) {
          info(`Results did not include the doc type of the partial JSON: `);
          await oada.delete({
            path: `bookmarks/trellisfw/trading-partners/masterid-index/${job["trading-partner"]}/shared/trellisfw/documents/${job!.config!["oada-doc-type"]}/${job!.config!.docKey}`
          })
        }

        // Record the result in the job
        await oada.put({
          path: `/resources/${jobId}`,
          //@ts-ignore
          data: {
            result: job!.result
          }
        })
        void log.info(
          'helper: stored result afte processing targetResult',
          {}
        );

        // ------------- 1: Look through all the things in result recursively,
        // if any are links then go there and set _meta/vdoc/pdf
        // Also, write a reference to the target-job that did it. This serves to
        // tell our ListWatch not to queue a target job when we add the
        // resource to /shared/trellisfw/documents/<doctype>
        // Really, this gets done already by fl-sync more than likely.
        void log.info(
          'helper: linking _meta/vdoc/pdf for each link in result',
          {}
        );
        async function recursivePutVdocAtLinks(object: unknown): Promise<void> {
          if (typeof object !== 'object' || !object) {
            return;
          }

          if (has(object, '_id')) {
            await oada.put({
              path: `/${object._id}/_meta`,
              data: {
                vdoc: { pdf: { _id: `${pdfID}` } },
              }
            });
            await oada.put({
              path: `/${object._id}/_meta`,
              data: {
                services: {
                  target: {
                    jobs: {
                      [jobId] : { _id: `resources/${jobId}` },
                    }
                  }
                }
              }
            });
            return;
          }

          for (const value of Object.values(object)) {
            // eslint-disable-next-line no-await-in-loop
            await recursivePutVdocAtLinks(value);
          }
        }

        await recursivePutVdocAtLinks(job.result);

        // ------------- 2: sign audit/coi/etc.
        void log.info('helper: signing all links in result', {});
        async function recursiveSignLinks(object: unknown): Promise<void> {
          if (typeof object !== 'object' || !object) {
            return;
          }

          if (has(object, '_id')) {
            await signResourceForTarget({
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

        // ------------- 3: put audits/cois/etc. to proper home
        const rootPath = job['trading-partner']
          ? `${TP_MASTER_PATH}/${job['trading-partner']}/shared/trellisfw/documents`
          : `/bookmarks/trellisfw/documents`;
        const versionedResult = recursiveMakeAllLinksVersioned(
          job.result
        ) as Record<TreeKey, unknown>;
        trace(versionedResult, 'all versioned links to bookmarks');

        for (const [doctype, data] of Object.entries(versionedResult)) {
          let docTypePath = rootPath + '/' + doctype;
          // Top-level keys are doc types
          // Automatically augment the base tree with the right content-type
          pointer.set(tree, docTypePath, {
            _type: 'application/vnd.trellisfw.documents.1+json',
            '*': {
              _type: fromOadaType(doctype)!.type
            }
          })

          //@ts-ignore
          for (const [docKey, docData] of Object.entries(data)) {
            void log.info('linking', `Linking doctype ${doctype} from result`);
            await oada.put({
              path: `${docTypePath}/${docKey}`,
              data: docData as Json,
              tree,
            });
          }
        }

        // ------------- 4: cross link vdoc for pdf <-> audits,cois,letters,etc.
        void log.info(
          'link-refs-pdf',
          'helper: linking result _refs under <pdf>/_meta/vdoc'
        );

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
        // NO LONGER NEEDED; THAT ENDPOINT NO LONGER CONTAINS UNIDed PDFS
        /*
        if (job.config && job.config['pdf-key']) {
          void log.info(
            'Unlinking from unidentified documents now that it is identified',
            {}
          );
          info(
            'Unlinking from unidentified documents now that it is identified'
          );
          await oada.delete({
            path: `${rootPath}/unidentified/${job.config['pdf-key']}`,
          });
        } else {
          void log.info('WARNING: Job had no documents key!', {});
        }
         */

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
              data: Record<string, Record<string, { _ref: string }>>;
            };
            trace(lookups, 'lookups');
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

              case 'cois': {
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
                  const { data: tp } = await oada.get({
                    path: `/${tpLink._id}`,
                  });
                  if (!has(tp, '_id')) {
                    throw new Error(
                      `Expected _id on trading partner ${tpLink._id}`
                    );
                  }

                  shares.push({
                    tp: { _id: `${tp._id}` },
                    doc: document,
                    dockey,
                  });
                }

                break;
              }

              case 'letters-of-guarantee': {
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
              }

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
            const tpKey = tp._id.replace(/^resources\//, '');
            // eslint-disable-next-line no-await-in-loop
            const { data: user } = await oada.get({ path: `/${tp._id}/user` });
            if (Buffer.isBuffer(user)) {
              throw new TypeError('user was not JSON');
            }

            // HACK FOR DEMO UNTIL WE GET MASKING SETTINGS:
            let mask:
              | { keys_to_mask: string[]; generate_pdf: boolean }
              | boolean = false;
            if (tpKey.includes('REDDYRAW')) {
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
            const {
              headers: { 'content-location': location },
              // eslint-disable-next-line no-await-in-loop
            } = await oada.post({
              path: `/resources`,
              contentType: tree.bookmarks?.services?.['*']?.jobs?.pending?.['*']?._type,
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
                  chroot: `/bookmarks/trellisfw/trading-partners/${tpKey}/user/bookmarks`,
                  tree: treeForDocumentType(doctype),
                },
              },
            });
            const resourceID = location?.replace(/^\//, '');
            const reskey = resourceID?.replace(/^resources\//, '');
            trace('Shares job posted as resid = %s', resourceID);
            const {
              headers: { 'content-location': jobpath },
              // eslint-disable-next-line no-await-in-loop
            } = await oada.put({
              path: `/bookmarks/services/trellis-shares/jobs`,
              data: { [reskey!]: { _id: resourceID, _rev: 0 } },
              tree,
            });
            const jobkey = jobpath?.replace(/^\/resources\/[^/]+\//, '');
            trace('Posted jobkey %s for shares', jobkey);
          }
        }

        void log.info('done', 'Completed all helper tasks');
        resolve(job.result as never);
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
            // We have one change that has time as a stringified unix timestamp.
            // I think target posts it: "information": "Job result loaded to resource: '281aZusXonG7b7ZYY5w8TCtedcZ'",
            // "time": "1650386464"
            // It throws a horrible deprecation warning, so address it here.
            if (parseInt(v.time)) {
              v.time = moment(parseInt(v.time)*1000).toISOString();
            }
            const t = clone(v.time);
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

      // eslint-disable-next-line security/detect-non-literal-fs-filename
//      const watchhandler = await oada.watch({
      const {changes} = await oada.watch({
        path: `${pending}/${jobId}`,
        type: 'single'
      });
      const { data } = await oada.get({
        path: `${pending}/${jobId}`,
      });
      // Initially just the original job is the "body" for a synthetic change
      const w = data as Change['body'];

      const unwatch = async () => {
        await changes.return?.();
//        await oada.unwatch(watchhandler);
      };

      if (Buffer.isBuffer(w)) {
        throw new TypeError('body is a buffer, cannot call jobChange');
      }

      await jobChange({
        path: '',
        body: w,
        type: 'merge',
      });

      for await (const change of changes) {
        await jobChange(change);
      }


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
  const values = Object.values(ei);
  trace(
    'Looking for facility %s in %d trading partners',
    facilityid,
    values.length
  );
  for (const tpv of values) {
    if (!tpv.facilities) {
      return; // Tp has no facilities
    }

    if (
      !Object.values(tpv.facilities).some((fLink) => fLink._id === facilityid)
    ) {
      return; // Have facilities, just not this one
    }

    // Do we need this cloneDeep?
    const { id, ...tp } = clone(tpv);
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
  const { data } = (await oada.get({ path: `/${_id}` })) as {
    data: Record<string, unknown>;
  };
  // Const { data: r } = await oada.get({ path: `/${_id}` });
  // const a = clone(r); // the actual audit or coi json

  try {
    // Test first if this thing already has a transcription signature.  If so, skip it.
    trace('#signResourceForTarget: Checking for existing signature...');
    // eslint-disable-next-line no-inner-declarations
    async function hasTranscriptionSignature(resource: {
      signatures?: string[];
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

    if (await hasTranscriptionSignature(data)) {
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
    const { signatures } = await tSignatures.sign(data, prvKey, {
      header,
      signer,
      type: signatureType,
    });

    info('PUTing signed signatures key only to /%s/signatures', _id);
    try {
      await oada.put({ path: `/${_id}/signatures`, data: signatures });
    } catch (cError: unknown) {
      error(cError, `Failed to apply signature to /${_id}/signatures`);
      throw new Error(`Failed to apply signature to /${_id}/signatures`);
    }
  } catch (cError: unknown) {
    error(cError, `Could not apply signature to resource ${_id}`);
    throw new Error(`Could not apply signature to resource ${_id}`);
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

    await con.ensure({
      path: `/bookmarks/trellisfw/trading-partners`,
      data: {},
      tree,
    })

    await con.ensure({
      path: `/bookmarks/trellisfw/coi-holders`,
      data: {},
      tree,
    })

    trace('Trading partners enabled %s', tradingPartnersEnabled);
    if (tradingPartnersEnabled) {
      // eslint-disable-next-line no-new
      new ListWatch({
        path: TP_MASTER_PATH,
        name: `target-helper-trading-partners`,
        conn: con,
        resume: false,
        onAddItem: watchTp,
      });
    }

    // Ensure the documents endpoint exists because Target is an enabler of that endpoint
    let path = `/bookmarks/trellisfw/documents`;
    await con.ensure({
      path,
      data: {},
      tree
    });

    //Watch primary user's documents
    // eslint-disable-next-line no-new
    new ListWatch({
      path,
      name: `TARGET-SF-docs`,
      conn: con,
      resume: false,
      onNewList: ListWatch.AssumeNew,
      onAddItem: documentTypeAdded(),
    });

    // eslint-disable-next-line no-inner-declarations
    async function cleanupBrokenLinks() {
      const { data: jobs = {} } = (await con.get({
        path: pending,
      })) as unknown as { data: Jobs };

      let count = 0;
      await Promise.all(
        Object.entries(jobs).map(async ([key, job]) => {
          if (key.startsWith('_')) {
            return;
          }

          if (Object.keys(job).length === 1 && job._rev) {
            count++;
            info(
              `cleaning up broken job ${pending}/${key}`
            );
            await con.delete({
              path: `${pending}/${key}`,
            });
          }
        })
      );
      info(`Done cleaning up ${count} target jobs`);
    }

    // For each trading partner, watch their documents list
    // eslint-disable-next-line no-inner-declarations
    async function watchTp(_tp: unknown, key: string) {
      key = key.replace(/^\//, '');
//      info(`New trading partner detected at key: [${key}]`);

      const path = `${TP_MASTER_PATH}/${key}/shared/trellisfw/documents`;
      await con.ensure({
        path,
        data: {},
        tree
      });
      info('Starting listwatch on %s', path);
      // eslint-disable-next-line no-new
      new ListWatch({
        path,
        name: `target-helper-tp-doctypes`,
        onNewList: ListWatch.AssumeNew,
        conn: con,
        resume: false,
        onAddItem: documentTypeAdded(key),
      });
    }

    // Now watch documents of that type
    // eslint-disable-next-line no-inner-declarations
    function documentTypeAdded(masterid?: string) {
      return async function (item: { _id: string }, key: string) {
        trace(`documentTypeAdded: ${key}: ${item}`)
        let docPath = masterid ? `${TP_MASTER_PATH}/${masterid}/shared/trellisfw/documents${key}`
          : `/bookmarks/trellisfw/documents${key}`;
        let docType = key.replace(/^\//, '');
        info('Starting trading partner doc type listwatch on %s', docPath);
        //Register new watch on
        new ListWatch({
          path: docPath,
          name: `target-helper-tp-docs`,
          onNewList: ListWatch.AssumeNew,
          conn: con,
          resume: true,
          onAddItem: documentAdded(docType, masterid),
        });
      }
    }

    // eslint-disable-next-line no-inner-declarations
    function documentAdded(docType: string, masterid?: string) {
      return async function (item: { _id: string }, key: string) {
        try {
          let {_id} = item;
          let path = masterid ? `${TP_MASTER_PATH}/${masterid}/shared/trellisfw/documents/${docType}`
            : `/bookmarks/trellisfw/documents/${docType}`;
          key = key.replace(/^\//, '')
          let meta : any = await con.get({
            path: `${path}/${key}/_meta`,
          }).then(r => r.data)

          if (meta && meta.services && meta.services["target-helper"]) {
            info(`target-helper has already been here. ${meta!.services!["target-helper"]}. Skipping this document`)
            return;
          }
          //TODO: Fix this. For now, take the first pdf
          if (!(meta && meta.vdoc && meta.vdoc.pdf)) {
            info(`No /_meta/vdoc/pdf. Skipping this doc`);
            return;
          }
          let pdfs = Object.values(meta!.vdoc!.pdf);
          let pdf = (pdfs)[0];
          info(`New Document was for ${masterid ? `tp with masterid=${masterid}`: 'Non-Trading Partner'}`);
          info(`New Document posted at ${path}/${key}`);

          // Fetch the PDF Document
//          let docs = Object.entries(meta!.vdoc || {});

          let data: any = {
            'trading-partner': masterid,
            'type': 'transcription',
            'service': 'target',
            'config': {
              type: 'pdf',
              pdf,
              document: { _id },
              docKey: key,
              "document-type": fromOadaType(docType)!.name,
              "oada-doc-type": docType,
            },
            _type: `application/vnd.oada.job.1+json`
          }

          try {
            const { headers } = await con.post({
              path: '/resources',
              contentType: 'application/vnd.oada.job.1+json',
              data
            });
            const jobkey = headers['content-location']!.replace(
              /^\/resources\//,
              ''
            );

            info('Posted job resource, jobkey = %s', jobkey);
            try {
              await con.put({
                path: pending,
                tree,
                data: {
                  [jobkey]: {
                    _id: `resources/${jobkey}`,
                    _rev: 0
                  },
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