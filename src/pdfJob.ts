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

/* eslint-disable complexity */

import config from './config.js';

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import clone from 'clone-deep';
import debug from 'debug';
import moment from 'moment';
import oError from '@overleaf/o-error';

import type { Change, JsonObject, OADAClient } from '@oada/client';
import type { Json, Logger, WorkerFunction } from '@oada/jobs';
import type { JWK } from '@trellisfw/signatures';
import type Job from '@oada/types/oada/service/job.js';
import type Jobs from '@oada/types/oada/service/jobs.js';
import type { Link } from '@oada/types/oada/link/v1.js';
import { ListWatch } from '@oada/list-lib';
import type Resource from '@oada/types/oada/resource.js';
import type { Tree } from '@oada/types/oada/tree/v1.js';
import type Update from '@oada/types/oada/service/job/update.js';
import { assert as assertJob } from '@oada/types/oada/service/job.js';
import { connect } from '@oada/client';
import tSignatures from '@trellisfw/signatures';

import { fromOadaType, matchesAlternateUrlNames } from './conversions.js';
import type { TreeKey } from './tree.js';
import tree from './tree.js';

const PERSIST_INTERVAL = config.get('oada.listWatch.persistInterval');

const tpTree: Tree = JSON.parse(JSON.stringify(tree));
delete tpTree.bookmarks?.trellisfw?.['trading-partners']?.['masterid-index']?.[
  '*'
]?.shared;
delete tpTree.bookmarks?.trellisfw?.['trading-partners']?.['masterid-index']?.[
  '*'
]?.bookmarks;

const documentTypeTree: Tree = JSON.parse(JSON.stringify(tree));
delete documentTypeTree.bookmarks!.trellisfw!.documents!['*'];

const tpDocumentTypeTree: Tree = JSON.parse(JSON.stringify(tree));
delete tpDocumentTypeTree.bookmarks!.trellisfw!['trading-partners']![
  'masterid-index'
]!['*']!.shared!.trellisfw!.documents!['*']!['*'];

const error = debug('target-helper:error');
const info = debug('target-helper:info');
const trace = debug('target-helper:trace');

const pending = '/bookmarks/services/target/jobs/pending';

type List<T> = Record<string, T>;

/**
 * Helper because TS is dumb and doesn't realize `in` means the key definitely exists.
 */
function has<T, K extends string>(
  value: T,
  key: K
): value is T & { [P in K]: unknown } {
  return value && typeof value === 'object' && key in value;
}

// Because OADA resource keys are always in the way
function stripResource<
  T extends
    | {
        _id?: unknown;
        _rev?: unknown;
        _meta?: unknown;
        _type?: unknown;
        _ref?: unknown;
      }
    | undefined
>(resource: T) {
  if (!resource) {
    return resource;
  }

  const { _id, _rev, _meta, _type, _ref, ...rest } = resource;
  return rest;
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
const TP_MASTER_PATH = '/bookmarks/trellisfw/trading-partners/masterid-index';

// Will fill in expandIndex on first job to handle
let expandIndex: {
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

/**
 * Receive the job from oada-jobs
 */
export const jobHandler: WorkerFunction = async (job, { jobId, log, oada }) => {
  trace({ job }, 'Received job');
  // Until oada-jobs adds cross-linking, make sure we are linked under the PDF's jobs
  trace('Linking job under pdf/_meta until oada-jobs can do that natively');
  // TODO: This seems broken when it writes to the target job
  const jobKey = jobId.replace(/^resources\//, '');
  await oada.put({
    path: `${pending}/${jobKey}/config/pdf/_meta/services/target/jobs`,
    data: {
      [jobKey]: { _ref: `${jobId}` },
    },
  });

  // Setup Expand index
  if (!expandIndex) {
    trace('First time through, fetching expandIndex');
    const { data: holders } = (await oada.ensure({
      path: '/bookmarks/trellisfw/coi-holders/expand-index',
      data: {},
      tree,
    })) as { data: Record<string, Record<string, unknown>> };
    const { data: partners } = (await oada.get({
      path: '/bookmarks/trellisfw/trading-partners/_meta/indexings/expand-index',
    })) as unknown as {
      data: Record<
        string,
        { id: string; facilities?: Record<string, { _id: string }> }
      >;
    };
    expandIndex = {
      'coi-holders': holders,
      'trading-partners': partners,
    };
  }

  return new Promise(async (resolve, reject) => {
    try {
      // - once it sees "success" in the updates,
      // it will post a job to trellis-signer and notify oada-jobs of success
      const targetSuccess = async () => {
        log.info(
          'helper-started',
          'Target returned success, target-helper picking up'
        );

        // Get the latest copy of job
        const r = await oada.get({ path: `/${jobId}` });
        assertJob(r.data); //TODO: This is already done in the jobs library?
        // FIXME: Make a proper type and assert
        // Note the types *should* be okay at runtime because these are needed to get to a target success
        const job = r.data as typeof r.data & {
          targetResult: List<List<Link>>;
          config: {
            'pdf': Link;
            'oada-doc-type': string;
            'document': Resource;
            'docKey': string;
          };
          result: List<List<Link>>;
        };

        // FIXME: Fail job if not exist?
        const pdfID = job.config.pdf._id;

        // ------------- 0: Construct the result from the targetResult
        // If/when a result that matches the input partial json is found,
        // merge the resource created by target into the partial json.
        // Do this all first and store it as the result for the remaining steps
        // to use.
        job.result = {};

        for await (const [documentType, data] of Object.entries(
          job.targetResult
        )) {
          info('Document identified as %s', documentType);

          job.result[documentType] = {};

          for await (const documentData of Object.values(data)) {
            // If the document type mismatches, move the link to the right place and let the flow start over.
            // Ex: LaserFiche "unidentified" documents, FoodLogiq wrong PDF uploaded, etc.
            // Note: One day we might officially separate "identification" from "transcription". This is almost that.
            // TODO: Reconsider this as it doesn't really work well with jobs created outside of the helper watches
            if (
              job.config['oada-doc-type'] !== documentType &&
              !matchesAlternateUrlNames(
                job.config['oada-doc-type'],
                documentType
              )
            ) {
              info(
                'Document type mismatch. Trellis: [%s], Target: [%s]. Moving tree location and bailing.',
                documentType,
                job.config['oada-doc-type']
              );

              trace(`Removing from ${job.config['oada-doc-type']} list.`);
              await oada.delete({
                path: join(
                  '/bookmarks/trellisfw/documents',
                  job.config['oada-doc-type'],
                  job.config.docKey
                ),
              });

              const newType = fromOadaType(documentType)?.type;

              trace(`Updating resource type to ${newType}`);
              await oada.put({
                path: job.config.document._id,
                data: { _type: newType },
              });
              await oada.put({
                path: join(job.config.document._id, '_meta'),
                data: { _type: newType },
              });

              trace(`Putting document into ${documentType} list.`);
              await oada.put({
                tree,
                path: join('/bookmarks/trellisfw/documents/', documentType),
                data: {
                  [job.config.docKey]: { _id: job.config.document._id, rev: 0 },
                },
              });

              void log.info(
                'done',
                'Document moved for proper doctype for re-processing.'
              );
              resolve(job.result as Json);
              return;
            }

            trace(
              'Merging from %s to %s.',
              documentData._id,
              job.config.document._id
            );
            const { data } = await oada.get({ path: documentData._id });
            await oada.put({
              path: job.config.document._id,
              data: stripResource(data as JsonObject),
            });

            job.result[documentType] = {
              ...job.result[documentType],
              // Write the target data to the original document
              [job.config.docKey]: { _id: job.config.document._id },
            };
          }
        }

        // Record the result in the job
        await oada.put({
          path: `/${jobId}`,
          data: {
            result: job.result as Json,
          },
        });
        void log.info(
          'helper: stored result after processing targetResult',
          {}
        );

        /* Target-helper not /expects/ this and does not need to re-create it (wrongly)

        // ------------- 1: Look through all the things in result recursively,
        // if any are links then go there and set _meta/vdoc/pdf
        // Also, write a reference to the target-job that did it. This serves to
        // tell our ListWatch not to queue a target job when we add the
        // resource to /shared/trellisfw/documents/<doctype>

        /* The _meta/vdoc/pdf/[hash] already exists under the new target-helper flow
        void log.info(
          'helper: linking _meta/vdoc/pdf for each link in result',
          {}
        );

        let pdfKey = (pdfID || '').replace(/^resources\//, '');
        async function recursivePutVdocAtLinks(object: unknown): Promise<void> {
          if (typeof object !== 'object' || !object) {
            return;
          }

          if (has(object, '_id')) {
            await oada.put({
              path: `/${object._id}/_meta`,
              data: {
                vdoc: {
                  pdf: {
                    [pdfKey]: { _id: `${pdfID}` },
                  },
                },
              },
            });
            await oada.put({
              path: `/${object._id}/_meta`,
              data: {
                services: {
                  target: {
                    jobs: {
                      [jobId]: { _ref: `resources/${jobId}` },
                    },
                  },
                },
              },
            });
            return;
          }

          for await (const value of Object.values(object)) {
            await recursivePutVdocAtLinks(value);
          }
        }

        await recursivePutVdocAtLinks(job.result);
        */

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

          for await (const value of Object.values(object)) {
            await recursiveSignLinks(value);
          }
        }

        await recursiveSignLinks(job.result);

        // ------------- 3: put audits/cois/etc. to proper home
        const versionedResult = recursiveMakeAllLinksVersioned(
          job.result
        ) as Record<TreeKey, Record<string, unknown>>;
        trace(versionedResult, 'all versioned links to bookmarks');

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

        // HARDCODED UNTIL AINZ IS UPDATED:
        // ------------- 6: lookup shares, post job to shares service
        // Only share for smithfield
        // why 'trading-partner' here with result
        const result = job['trading-partner'] ? {} : job.result ?? {};

        for await (const doctype of Object.keys(result)) {
          const shares: Shares = [];
          // Results are lists of links?
          const doclist = (job.result?.[doctype] ?? {}) as Record<
            string,
            { _id: string }
          >;
          for await (const [dockey, document] of Object.entries(doclist)) {
            trace(
              'Fetching lookups for doctype = %s, doc = %O, getting /%s/_meta/lookups',
              doctype,
              document,
              document._id
            );
            const { data: lookups } = (await oada.get({
              path: `/${document._id}/_meta/lookups`,
            })) as unknown as {
              data: Record<string, Record<string, { _ref: string }>>;
            };
            trace(lookups, 'lookups');
            let facilityID;
            switch (doctype) {
              case 'fsqa-audits': {
                facilityID = lookups['fsqa-audit']!.organization!._ref;
                await pushSharesForFacility({
                  facilityid: facilityID,
                  doc: document,
                  dockey,
                  shares,
                });
                break;
              }

              case 'fsqa-certificates': {
                facilityID = lookups['fsqa-certificate']!.organization!._ref;
                await pushSharesForFacility({
                  facilityid: facilityID,
                  doc: document,
                  dockey,
                  shares,
                });
                break;
              }

              case 'cois': {
                const { data: holder } = (await oada.get({
                  path: `/${lookups.coi!.holder!._ref}`,
                })) as unknown as {
                  data: { 'trading-partners': Record<string, { _id: string }> };
                };
                trace({ holder }, 'Retrieved holder');
                for await (const tpLink of Object.values(
                  holder['trading-partners']
                )) {
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
                const { data: buyer } = (await oada.get({
                  path: `/${lookups['letter-of-guarantee']!.buyer!._ref}`,
                })) as unknown as {
                  data: { 'trading-partners': Record<string, { _id: string }> };
                };
                trace('Retrieved buyer %O', buyer);
                for await (const tpLink of Object.values(
                  buyer['trading-partners']
                )) {
                  const { data: tp } = (await oada.get({
                    path: `/${tpLink._id}`,
                  })) as unknown as { data: { _id: string } };
                  shares.push({ tp, doc: document, dockey });
                }

                break;
              }

              default: {
                throw new Error(
                  `Unknown document type (${doctype}) when attempting to do lookups`
                );
              }
            }
          }

          void log.info(
            'sharing',
            `Posting ${shares.length} shares jobs for doctype ${doctype} resulting from this transcription`
          );
          for await (const { dockey, doc, tp } of shares) {
            const tpKey = tp._id.replace(/^resources\//, '');
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
            } = await oada.post({
              path: `/resources`,
              contentType:
                tree.bookmarks?.services?.['*']?.jobs?.pending?.['*']?._type,
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
        resolve(job.result as Json);
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
          for await (const [k, v] of Object.entries(updates)) {
            // We have one change that has time as a stringified unix timestamp.
            // I think target posts it: "information": "Job result loaded to resource: '281aZusXonG7b7ZYY5w8TCtedcZ'",
            // "time": "1650386464"
            // It throws a horrible deprecation warning, so address it here.
            if (Number.parseInt(v.time, 10)) {
              v.time = moment(Number.parseInt(v.time, 10) * 1000).toISOString();
            }

            const t = clone(v.time);
            v.time = moment(v.time).toISOString();
            if (v.time === null) {
              // @ts-expect-error --- ?
              v.time = moment(t, 'X');
            }
            /*
            If (
              v.information ===
              'File is not a Textual PDF,requires OCR to be processed.'
            ) {
              await oada.post({
                path: `/${jobId}/updates`,
                data: {
                  status: 'error',
                  information: v.information,
                },
              });
            }
             */

            // Fix for Target identifying loop
            if (v.status === 'identifying') {
              const otherUpdates = await oada
                .get({
                  path: `/${jobId}/updates`,
                })
                .then((r: any) => r.data as unknown as JsonObject);

              const others = Object.values(otherUpdates).filter(
                (object: any) =>
                  object.status && object.status === 'identifying'
              );
              if (others.length > 5) {
                info(
                  `Job ${jobId} stuck in 'identifying' loop for more than 5 minutes. Timing out.`
                );
                await oada.post({
                  path: `/${jobId}/updates`,
                  data: {
                    status: 'error',
                    information: 'TimeoutError',
                  },
                });
              } else {
                trace(
                  `Job ${jobId} update status 'identifying' happened less than 10 times.`
                );
              }
            }

            trace(v, '#jobChange: change update');
            if (v.status === 'success') {
              trace(
                '#jobChange: unwatching job and moving on with success tasks'
              );
              await unwatch();
              // @ts-expect-error TODO: Why pass stuff to this function with no arguments?
              // eslint-disable-next-line sonarjs/no-extra-arguments
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
                `Target returned error: ${JSON.stringify(v, undefined, '  ')}`
              );
            }
          }
        } catch (cError: unknown) {
          reject(cError);
        }
      };

      const { changes } = await oada.watch({
        path: `${pending}/${jobKey}`,
        type: 'single',
      });
      const { data } = await oada.get({
        path: `${pending}/${jobKey}`,
      });
      // Initially just the original job is the "body" for a synthetic change
      const w = data as Change['body'];

      const unwatch = async () => {
        await changes.return?.();
        //        Await oada.unwatch(watchhandler);
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
    info(`Connecting to DOMAIN ${domain} with concurrency ${CONCURRENCY}`);
    const con = await connect({ domain, token, concurrency: CONCURRENCY });

    await cleanupBrokenLinks();
    setInterval(cleanupBrokenLinks, 600_000);

    await con.ensure({
      path: `/bookmarks/trellisfw/trading-partners`,
      data: {},
      tree,
    });

    await con.ensure({
      path: `/bookmarks/trellisfw/coi-holders`,
      data: {},
      tree,
    });

    // Adding these trees because the recursiveGet within ListWatch recurses too deep otherwise
    trace('Trading partners enabled %s', tradingPartnersEnabled);
    if (tradingPartnersEnabled) {
      // eslint-disable-next-line no-new
      new ListWatch({
        path: TP_MASTER_PATH,
        name: `target-helper-trading-partners`,
        conn: con,
        resume: false,
        onAddItem: watchTp,
        onNewList: ListWatch.AssumeNew,
        tree: { ...tpTree },
        persistInterval: PERSIST_INTERVAL,
      });
    }

    // Ensure the documents endpoint exists because Target is an enabler of that endpoint
    const path = `/bookmarks/trellisfw/documents`;
    await con.ensure({
      path,
      data: {},
      tree,
    });

    // Watch primary user's documents
    // eslint-disable-next-line no-new
    new ListWatch({
      path,
      name: `TARGET-SF-docs`,
      conn: con,
      resume: false,
      onNewList: ListWatch.AssumeNew,
      onAddItem: documentTypeAdded(),
      tree: { ...documentTypeTree },
      persistInterval: PERSIST_INTERVAL,
    });

    // eslint-disable-next-line no-inner-declarations
    async function cleanupBrokenLinks() {
      await con.ensure({
        path: pending,
        data: {},
        tree,
      });
      const { data: jobs = {} } = (await con.get({
        path: pending,
      })) as unknown as { data: Jobs };

      let count = 0;
      await Promise.all(
        Object.entries<Job>(jobs).map(async ([key, job]) => {
          if (key.startsWith('_')) {
            return;
          }

          if (Object.keys(job).length === 1 && job._rev) {
            count++;
            info(`cleaning up broken job ${pending}/${key}`);
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
      // FOR DEBUGGING:
      // if (key !== 'd4f7b367c7f6aa30841132811bbfe95d3c3a807513ac43d7c8fea41a6688606e') return
      info(`New trading partner detected at key: [${key}]`);
      const documentsPath = `${TP_MASTER_PATH}/${key}/shared/trellisfw/documents`;
      await con.ensure({
        path: documentsPath,
        data: {},
        tree,
      });
      info('Starting listwatch on %s', documentsPath);
      // eslint-disable-next-line no-new
      new ListWatch({
        path: documentsPath,
        name: `target-helper-tp-doctypes`,
        onNewList: ListWatch.AssumeNew,
        conn: con,
        resume: false,
        onAddItem: documentTypeAdded(key),
        tree: tpDocumentTypeTree,
        persistInterval: PERSIST_INTERVAL,
      });
    }

    // Now watch documents of that type
    // eslint-disable-next-line no-inner-declarations
    function documentTypeAdded(masterid?: string) {
      return async function (item: { _id: string }, key: string) {
        trace({ item, key }, 'documentTypeAdded');
        const documentPath = masterid
          ? `${TP_MASTER_PATH}/${masterid}/shared/trellisfw/documents${key}`
          : `/bookmarks/trellisfw/documents${key}`;
        const documentType = key.replace(/^\//, '');
        info('Starting trading partner doc type listwatch on %s', documentPath);
        // Register new watch on
        // eslint-disable-next-line no-new
        new ListWatch({
          path: documentPath,
          name: `target-helper-tp-docs`,
          onNewList: ListWatch.AssumeNew,
          conn: con,
          resume: true,
          onAddItem: documentAdded(documentType, masterid),
          tree: tpDocumentTypeTree,
          persistInterval: PERSIST_INTERVAL,
        });
      };
    }

    // eslint-disable-next-line no-inner-declarations
    function documentAdded(documentType: string, masterid?: string) {
      return async function (item: { _id: string }, key: string) {
        try {
          const { _id } = item;
          const typePath = masterid
            ? `${TP_MASTER_PATH}/${masterid}/shared/trellisfw/documents/${documentType}`
            : `/bookmarks/trellisfw/documents/${documentType}`;
          key = key.replace(/^\//, '');
          const { data: meta } = (await con.get({
            path: `${typePath}/${key}/_meta`,
          })) as {
            data?: {
              services?: Record<string, unknown>;
              vdoc?: { pdf?: Record<string, unknown> };
            };
          };

          if (meta?.services?.['target-helper']) {
            info(
              'target-helper has already been here. %s. Skipping this document',
              meta.services['target-helper']
            );
            return;
          }

          // FIXME: For now, take the first pdf
          if (!meta?.vdoc?.pdf) {
            info(`No /_meta/vdoc/pdf. Skipping this doc`);
            return;
          }

          const pdfs = Object.values(meta.vdoc.pdf);
          const pdf = pdfs[0];
          info(
            `New Document was for ${
              masterid ? `tp with masterid=${masterid}` : 'Non-Trading Partner'
            }`
          );
          info('New Document posted at %s/%s', typePath, key);

          // Fetch the PDF Document
          //          let docs = Object.entries(meta!.vdoc || {});

          const data = {
            'trading-partner': masterid, //just for documentation
            'type': 'transcription',
            'service': 'target',
            'config': {
              'type': 'pdf',
              pdf,
              'document': { _id },
              'docKey': key,
              'document-type': fromOadaType(documentType)?.name || 'unknown',
              'oada-doc-type': documentType,
            },
            '_type': `application/vnd.oada.job.1+json`,
          };

          try {
            const { headers } = await con.post({
              path: '/resources',
              contentType: 'application/vnd.oada.job.1+json',
              data: data as Json,
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
                    _rev: 0,
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
              _id
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