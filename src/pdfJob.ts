/**
 * @license
 * Copyright 2021 Qlever LLC
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

import config from './config.js';

// eslint-disable-next-line unicorn/import-style
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import clone from 'clone-deep';
import debug from 'debug';
import moment from 'moment';
import oError from '@overleaf/o-error';

import { AssumeState, ChangeType, ListWatch } from '@oada/list-lib';
import type { Change, JsonObject, OADAClient } from '@oada/client';
import type { Job, Json, Logger, WorkerFunction } from '@oada/jobs';
import { Gauge } from '@oada/lib-prom';
import type { JWK } from '@trellisfw/signatures';
import type { Link } from '@oada/types/oada/link/v1.js';
import type Resource from '@oada/types/oada/resource.js';
import type Update from '@oada/types/oada/service/job/update.js';
import { assert as assertJob } from '@oada/types/oada/service/job.js';
import { connect } from '@oada/client';
import tSignatures from '@trellisfw/signatures';

import {
  documentTypeTree,
  tpDocsTree,
  tpDocumentTypeTree,
  tpTree,
  tree,
} from './tree.js';
import { fromOadaType, matchesAlternateUrlNames } from './conversions.js';
import type { TreeKey } from './tree.js';

// Const PERSIST_INTERVAL = config.get('oada.listWatch.persistInterval');

const error = debug('target-helper:error');
const info = debug('target-helper:info');
const trace = debug('target-helper:trace');

const pending = '/bookmarks/services/target/jobs/pending';

const targetTimeout = config.get('timeouts.simx');
const jobs = new Gauge({
  name: 'target_helper_jobs',
  help: 'Number of jobs in the pending queue',
});

const errors = new Gauge({
  name: 'target_helper_errors',
  help: 'Number of errored jobs',
});

type List<T> = Record<string, T>;

/**
 * Helper because TS is dumb and doesn't realize `in` means the key definitely exists.
 */
function has<T, K extends string>(
  value: T,
  key: K,
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
  | undefined,
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
const TP_PATH = '/bookmarks/trellisfw/trading-partners';

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
    ]),
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
    ]),
  );
}

/**
 * Receive the job from oada-jobs
 */
export const jobHandler: WorkerFunction = async (job, { jobId, log, oada }) => {
  jobs.inc();
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

  return handleJob({ jobId, log, oada });
};

async function targetSuccess({
  jobId,
  log,
  oada,
}: {
  jobId: string;
  log: Logger;
  oada: OADAClient;
}): Promise<Json> {
  void log.info(
    'helper-started',
    'Target returned success, target-helper picking up',
  );

  // Get the latest copy of job
  const r = await oada.get({ path: `/${jobId}` });
  assertJob(r.data); // TODO: This is already done in the jobs library?
  // FIXME: Make a proper type and assert
  // Note the types *should* be okay at runtime because these are needed to get to a target success
  const job = r.data as typeof r.data & {
    targetResult: List<List<Link>>;
    config: {
      'pdf': Link;
      // eslint-disable-next-line sonarjs/no-duplicate-string
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

  for await (const [documentType, data] of Object.entries(job.targetResult)) {
    info('Document identified as %s', documentType);

    job.result[documentType] = {};

    for await (const documentData of Object.values(data)) {
      // If the document type mismatches, move the link to the right place and let the flow start over.
      // Ex: LaserFiche "unidentified" documents, FoodLogiq wrong PDF uploaded, etc.
      // Note: One day we might officially separate "identification" from "transcription". This is almost that.
      // TODO: Reconsider this as it doesn't really work well with jobs created outside of the helper watches
      if (
        // Added the 'unidentified' check to stop doing this flow for misidentified
        // documents coming through e.g. fl-sync. Theres just too much cross over of
        // one doc type used to satisfy another doc type. e.g. we may ask a product label to be extract it
        // and target may recognize it as nutrition information because it contains both. This condition
        // lets us continue doing this for jobs specifically coming in as unidentified
        job.config['oada-doc-type'] === 'unidentified' &&
        job.config['oada-doc-type'] !== documentType &&
        !matchesAlternateUrlNames(job.config['oada-doc-type'], documentType)
      ) {
        info(
          'Document type mismatch. Trellis: [%s], Target: [%s]. Moving tree location and bailing.',
          documentType,
          job.config['oada-doc-type'],
        );

        trace(`Removing from ${job.config['oada-doc-type']} list.`);
        await oada.delete({
          path: join(
            '/bookmarks/trellisfw/documents',
            job.config['oada-doc-type'],
            job.config.docKey,
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
          'Document moved for proper doctype for re-processing.',
        );
        jobs.dec();
        return job.result as Json;
      }

      trace(
        'Merging from %s to %s.',
        documentData._id,
        job.config.document._id,
      );
      const { data: doc } = await oada.get({ path: documentData._id });
      await oada.put({
        path: job.config.document._id,
        data: stripResource(doc as JsonObject),
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
  void log.info('helper: stored result after processing targetResult', {});

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
  const versionedResult = recursiveMakeAllLinksVersioned(job.result) as Record<
    TreeKey,
    Record<string, unknown>
  >;
  trace(versionedResult, 'all versioned links to bookmarks');

  // ------------- 4: cross link vdoc for pdf <-> audits,cois,letters,etc.
  void log.info(
    'link-refs-pdf',
    'helper: linking result _refs under <pdf>/_meta/vdoc',
  );

  const vdoc = recursiveReplaceLinksWithReferences(job.result);
  info(
    "Linking _ref's into pdf/_meta, job.result before: %O, after: %O",
    job.result,
    vdoc,
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
        document._id,
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
            holder['trading-partners'],
          )) {
            const { data: tp } = await oada.get({
              path: `/${tpLink._id}`,
            });
            if (!has(tp, '_id')) {
              throw new Error(`Expected _id on trading partner ${tpLink._id}`);
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
          for await (const tpLink of Object.values(buyer['trading-partners'])) {
            const { data: tp } = (await oada.get({
              path: `/${tpLink._id}`,
            })) as unknown as { data: { _id: string } };
            shares.push({ tp, doc: document, dockey });
          }

          break;
        }

        default: {
          throw new Error(
            `Unknown document type (${doctype}) when attempting to do lookups`,
          );
        }
      }
    }

    void log.info(
      'sharing',
      `Posting ${shares.length} shares jobs for doctype ${doctype} resulting from this transcription`,
    );
    for await (const { dockey, doc, tp } of shares) {
      const tpKey = tp._id.replace(/^resources\//, '');
      const { data: user } = await oada.get({ path: `/${tp._id}/user` });
      if (user instanceof Uint8Array) {
        throw new TypeError('user was not JSON');
      }

      // HACK FOR DEMO UNTIL WE GET MASKING SETTINGS:
      let mask: { keys_to_mask: string[]; generate_pdf: boolean } | boolean =
        false;
      if (tpKey.includes('REDDYRAW')) {
        info('COPY WILL MASK LOCATIONS FOR REDDYRAW');
        trace(
          'pdf is only generated for fsqa-audits or cois, doctype is %s',
          doctype,
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
            // eslint-disable-next-line @typescript-eslint/ban-types
            user: user as unknown as object, // { id, bookmarks }
            chroot: `/bookmarks/trellisfw/trading-partners/${tpKey}/user/bookmarks`,
            tree: treeForDocumentType(doctype),
          },
        },
      });
      const resourceID = location?.replace(/^\//, '');
      const reskey = resourceID?.replace(/^resources\//, '');
      trace('Shares job posted as resId = %s', resourceID);
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

  jobs.dec();
  return job.result as Json;
}

async function handleTargetTimeout({
  jobId,
  oada,
}: {
  jobId: string;
  oada: OADAClient;
}) {
  const { data } = (await oada.get({ path: `/${jobId}` })) as unknown as {
    data: Job;
  };
  if (!data?.status) {
    // Handle timeout here
    await oada.post({
      path: `/${jobId}/updates`,
      data: {
        status: 'error',
        information: 'TimeoutError',
      },
    });
    // You can also throw an error or perform any other necessary actions
  }
}

async function jobChange({
  jobId,
  log,
  oada,
  c,
  unwatch,
}: {
  jobId: string;
  log: Logger;
  oada: OADAClient;
  c: Omit<Change, 'resource_id'>;
  unwatch: () => Promise<void>;
}) {
  trace('#jobChange: received change, c = %O ', c);
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
    // Not an update from target
    return;
  }

  trace('#jobChange: it is a change we want (has an update)');
  for await (const v of Object.values(updates)) {
    // We have one change that has time as a stringified unix timestamp.
    // I think target posts it: "information": "Job result loaded to resource: '281aZusXonG7b7ZYY5w8TCteDcZ'",
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

    trace(v, '#jobChange: change update');
    switch (v.status) {
      // Fix for Target identifying loop
      case 'identifying': {
        setTimeout(async () => {
          await handleTargetTimeout({ jobId, oada });
          await unwatch();
        }, targetTimeout);

        break;
      }

      case 'success': {
        trace('#jobChange: unwatching job and moving on with success tasks');
        await unwatch();

        return targetSuccess({
          jobId,
          log,
          oada,
        });
      }

      case 'error': {
        error('#jobChange: unwatching job and moving on with error tasks');
        await unwatch();
        if (v.information) {
          error('Target job [%s] failed: %O', jobId, v.information);
        }

        throw new Error(
          `Target job ${jobId} returned an error`,
          { cause: v }
        );
      }

      default:
      // Do nothing?
    }
  }

  // eslint-disable-next-line unicorn/no-useless-undefined
  return undefined;
}

async function handleJob({
  jobId,
  log,
  oada,
}: {
  jobId: string;
  log: Logger;
  oada: OADAClient;
  // @ts-expect-error rewrite differently?
}): Promise<Json> {
  try {
    // - once it sees "success" in the updates,
    // it will post a job to trellis-signer and notify oada-jobs of success
    const { changes } = await oada.watch({
      path: `/${jobId}`,
      type: 'single',
    });

    const unwatch = async () => {
      await changes.return?.();
    };

    // Create a synthetic change for the current state of things when the job starts
    await makeSyntheticChange({
      jobId,
      log,
      oada,
      unwatch,
    });

    for await (const change of changes) {
      const result = await jobChange({ jobId, log, oada, c: change, unwatch });
      if (result !== undefined) {
        return result;
      }
    }
  } catch (cError: unknown) {
    jobs.dec();
    errors.inc();
    throw new Error(`Error handling job ${jobId}`, { cause: cError });
  }
}

async function makeSyntheticChange({
  jobId,
  log,
  oada,
  unwatch,
}: {
  jobId: string;
  log: Logger;
  oada: OADAClient;
  unwatch: () => Promise<void>;
}): Promise<void> {
  const { data } = await oada.get({
    path: `/${jobId}`,
  });
  // Initially just the original job is the "body" for a synthetic change
  const w = data as Change['body'];

  if (w instanceof Uint8Array) {
    throw new TypeError('body is binary, cannot call jobChange');
  }

  await jobChange({
    jobId,
    log,
    oada,
    c: {
      path: '',
      body: w,
      type: 'merge',
    },
    unwatch,
  });
}

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
    values.length,
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
        payload,
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
        {},
      );
      return true;
    }

    trace(
      '#signResourceForTarget: Did not find existing %s signature, signing...',
      signatureType,
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
        `ERROR: doctype ${doctype} has dashes, but is not easily convertible to singular word for _type`,
      );
    }

    singularType = parts.join('-');
  } else {
    throw new Error(
      `ERROR: doctype ${doctype} is not easily convertible to singular word for _type`,
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
      path: TP_PATH,
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
      const tpWatch = new ListWatch({
        path: TP_PATH,
        conn: con,
        resume: false,
        onNewList: AssumeState.New,
        tree: tpTree,
      });
      tpWatch.on(ChangeType.ItemAdded, watchTp);
      process.on('beforeExit', async () => tpWatch.stop());
    }

    // Ensure the documents endpoint exists because Target is an enabler of that endpoint
    const path = `/bookmarks/trellisfw/documents`;
    await con.ensure({
      path,
      data: {},
      tree,
    });

    // Watch primary user's documents
    const selfDocumentsTypesWatch = new ListWatch<Resource>({
      path,
      conn: con,
      resume: false,
      onNewList: AssumeState.New,
      tree: documentTypeTree,
    });
    selfDocumentsTypesWatch.on(ChangeType.ItemAdded, documentTypeAdded());
    process.on('beforeExit', async () => selfDocumentsTypesWatch.stop());

    // eslint-disable-next-line no-inner-declarations
    async function cleanupBrokenLinks() {
      await con.ensure({
        path: pending,
        data: {},
        tree,
      });
      const { data: pendingJobs = {} } = (await con.get({
        path: pending,
      })) as unknown as { data: Record<string, Job & { _rev: string }> };

      let count = 0;
      await Promise.all(
        Object.entries<Job & { _rev: string }>(pendingJobs).map(async ([key, job]) => {
          if (key.startsWith('_')) {
            return;
          }

          if (Object.keys(job).length === 1 && job._rev) {
            count++;
            info(`cleaning up broken job ${pending}/${key} (total: ${count})`);
            await con.delete({
              path: `${pending}/${key}`,
            });
          }
        }),
      );
      // Info(`Done cleaning up ${count} target jobs`);
    }

    // For each trading partner, watch their documents list
    // eslint-disable-next-line no-inner-declarations
    async function watchTp({ pointer: masterId }: { pointer: string }) {
      masterId = masterId.replace(/^\//, '');
      // FOR DEBUGGING:
      // if (masterId!== 'd4f7b367c7f6aa30841132811bbfe95d3c3a807513ac43d7c8fea41a6688606e') return
      info(`New trading partner detected at key: [${masterId}]`);
      const documentsPath = join(
        TP_PATH,
        masterId,
        '/shared/trellisfw/documents',
      );
      await con.ensure({
        path: documentsPath,
        data: {},
        tree: tpDocsTree,
      });
      info('Starting listwatch on %s', documentsPath);
      const docsWatch = new ListWatch<Resource>({
        path: documentsPath,
        onNewList: AssumeState.New,
        conn: con,
        resume: false,
        tree: tpDocsTree,
        // PersistInterval: PERSIST_INTERVAL,
      });
      docsWatch.on(ChangeType.ItemAdded, documentTypeAdded(masterId));
      process.on('beforeExit', async () => docsWatch.stop());
    }

    // Now watch documents of that type
    // eslint-disable-next-line no-inner-declarations
    function documentTypeAdded(masterid?: string) {
      return async function ({
        item: itProm,
        pointer: docType,
      }: {
        item: Promise<Resource>;
        pointer: string;
      }) {
        const item = await itProm;
        trace({ item, docType }, 'documentTypeAdded');
        const documentPath = masterid
          ? join(TP_PATH, masterid, '/shared/trellisfw/documents', docType)
          : join('/bookmarks/trellisfw/documents', docType);
        docType = docType.replace(/^\//, '');
        info('Starting trading partner doc type listwatch on %s', documentPath);
        // Register new watch on
        const docTypeWatch = new ListWatch<Resource>({
          path: documentPath,
          name: `target-helper-tp-docs`,
          onNewList: AssumeState.Handled,
          conn: con,
          resume: true,
          tree: tpDocumentTypeTree,
          // PersistInterval: PERSIST_INTERVAL,
        });
        docTypeWatch.on(ChangeType.ItemAdded, documentAdded(docType, masterid));
        /*
          We cannot use this one unless we can identify our own target-helper-induced changes
          and filter them out of being handled here.
        docTypeWatch.on(
          ChangeType.ItemChanged,
          documentAdded(docType, masterid)
        );
        */
        process.on('beforeExit', async () => docTypeWatch.stop());
      };
    }

    // eslint-disable-next-line no-inner-declarations
    function documentAdded(documentType: string, masterid?: string) {
      return async function ({
        item: itProm,
        pointer: key,
        change,
      }: {
        item: Promise<Resource>;
        pointer: string;
        change?: Change;
      }) {
        try {
          let item: Resource;
          if (change) {
            const resp = await con.get({ path: change.resource_id });
            item = resp.data as Resource;
          } else {
            item = await itProm;
          }

          const { _id } = item;
          const typePath = masterid
            ? `${TP_PATH}/${masterid}/shared/trellisfw/documents/${documentType}`
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
              meta.services['target-helper'],
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
            `New Document was for ${masterid ? `tp with masterid=${masterid}` : 'Non-Trading Partner'
            }`,
          );
          info('New Document posted at %s/%s', typePath, key);

          // Fetch the PDF Document
          //          let docs = Object.entries(meta!.vdoc || {});

          const data = {
            'trading-partner': masterid, // Just for documentation
            'type': 'transcription',
            'service': 'target',
            'config': {
              'type': 'pdf',
              pdf,
              'document': { _id },
              'docKey': key,
              'document-type': fromOadaType(documentType)?.name ?? 'unknown',
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
              '',
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
                jobkey,
              );
            }
          } catch (cError: unknown) {
            throw oError.tag(
              cError as Error,
              'Failed to create new job resource for item ',
              _id,
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
