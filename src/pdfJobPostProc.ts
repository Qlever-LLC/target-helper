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

import { readFile } from 'node:fs/promises';

import type { Json } from '@oada/jobs';
import type { JWK } from '@trellisfw/signatures';
import type { Link } from '@oada/types/oada/link/v1.js';
import type { Logger } from '@oada/pino-debug';
import type { OADAClient } from '@oada/client';
import tSignatures from '@trellisfw/signatures';

import type { ExpandIndex, TargetJob } from './pdfJob.js';
import { has, treeForDocumentType } from './utils.js';
import { tree } from './tree.js';

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

// Iterate over result and handle lookups for different doc types and post jobs to shares service
export async function handleShares(
  job: TargetJob,
  expandIndex: ExpandIndex,
  oada: OADAClient,
  log: Logger,
) {
  // Only share for smithfield
  if (job['trading-partner']) return;

  for await (const [doctype, doclist] of Object.entries(job.result)) {
    const shares: Shares = [];

    for await (const [dockey, document] of Object.entries(doclist)) {
      log.trace(
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
      log.trace(lookups, 'lookups');
      let facilityID;
      switch (doctype) {
        case 'fsqa-audits': {
          facilityID = lookups['fsqa-audit']!.organization!._ref;
          await pushSharesForFacility({
            log,
            facilityid: facilityID,
            doc: document,
            dockey,
            shares,
            expandIndex,
          });
          break;
        }

        case 'fsqa-certificates': {
          facilityID = lookups['fsqa-certificate']!.organization!._ref;
          await pushSharesForFacility({
            log,
            facilityid: facilityID,
            doc: document,
            dockey,
            shares,
            expandIndex,
          });
          break;
        }

        case 'cois': {
          const { data: holder } = (await oada.get({
            path: `/${lookups.coi!.holder!._ref}`,
          })) as unknown as {
            data: { 'trading-partners': Record<string, { _id: string }> };
          };
          log.trace({ holder }, 'Retrieved holder');
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
          log.trace('Retrieved buyer %O', buyer);
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

    log.info(
      'sharing',
      `Posting ${shares.length} shares jobs for doctype ${doctype} resulting from this transcription`,
    );
    for await (const { dockey, doc, tp } of shares) {
      const tpKey = tp._id.replace(/^resources\//, '');
      const { data: user } = (await oada.get({
        path: `/${tp._id}/user`,
      })) as unknown as { data: Link };
      if (user instanceof Uint8Array) {
        throw new TypeError('user was not JSON');
      }

      // HACK FOR DEMO UNTIL WE GET MASKING SETTINGS:
      let mask: Mask | boolean = false;
      if (tpKey.includes('REDDYRAW')) {
        log.info('COPY WILL MASK LOCATIONS FOR REDDYRAW');
        log.trace(
          'pdf is only generated for fsqa-audits or cois, doctype is %s',
          doctype,
        );
        mask = {
          keys_to_mask: ['location'],
          generate_pdf: doctype === 'fsqa-audits' || doctype === 'cois',
        };
      }
      // END HACK FOR DEMO

      await postSharesJob({
        log,
        doc,
        doctype,
        dockey,
        tpKey,
        user,
        mask,
        oada,
      });
    }
  }
}

async function postSharesJob({
  log,
  doc,
  doctype,
  dockey,
  tpKey,
  user,
  mask,
  oada,
}: {
  log: Logger;
  doc: Link;
  doctype: string;
  dockey: string;
  tpKey: string;
  user: Link;
  mask: Mask | boolean;
  oada: OADAClient;
}) {
  const {
    headers: { 'content-location': location },
  } = await oada.post({
    path: `/resources`,
    contentType: 'application/vnd.oada.service.job.1+json',
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
    } as unknown as Json, // Should be SharesJob, but JsonObject is a pita
  });
  const resourceID = location?.replace(/^\//, '');
  const reskey = resourceID?.replace(/^resources\//, '');
  log.trace('Shares job posted as resId = %s', resourceID);
  const {
    headers: { 'content-location': jobpath },
  } = await oada.put({
    path: `/bookmarks/services/trellis-shares/jobs`,
    data: { [reskey!]: { _id: resourceID, _rev: 0 } },
    tree,
  });
  const jobkey = jobpath?.replace(/^\/resources\/[^/]+\//, '');
  log.trace('Posted jobkey %s for shares', jobkey);
}

export async function recursiveSignLinks(
  object: unknown,
  oada: OADAClient,
  log: Logger,
): Promise<void> {
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
    await recursiveSignLinks(value, oada, log);
  }
}

async function pushSharesForFacility({
  log,
  facilityid,
  doc,
  dockey,
  shares,
  expandIndex,
}: {
  log: Logger;
  facilityid: string;
  doc: { _id: string };
  dockey: string;
  shares: Shares;
  expandIndex: ExpandIndex;
}) {
  const ei = expandIndex['trading-partners'];
  const values = Object.values(ei);
  log.trace(
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
    const { id, ...tp } = structuredClone(tpv);
    const s = { tp: { _id: id, ...tp }, doc, dockey };
    shares.push(s);
    log.trace('Added share to running list: %O', s);
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
    log.trace('#signResourceForTarget: Checking for existing signature...');
    // eslint-disable-next-line no-inner-declarations
    async function hasTranscriptionSignature(resource: {
      signatures?: string[];
    }): Promise<boolean> {
      if (!resource.signatures) {
        return false;
      }

      const { trusted, valid, unchanged, payload, original } =
        await tSignatures.verify(resource);
      log.trace(
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
      log.error(
        `#signResourceForTarget: Item ${_id} already has a transcription signature on it, choose to skip it and not apply a new one`,
        {},
      );
      return true;
    }

    log.trace(
      '#signResourceForTarget: Did not find existing %s signature, signing...',
      signatureType,
    );

    // Otherwise, go ahead and apply the signature
    const { signatures } = await tSignatures.sign(data, prvKey, {
      header,
      signer,
      type: signatureType,
    });

    log.info('PUTing signed signatures key only to /%s/signatures', _id);
    try {
      await oada.put({ path: `/${_id}/signatures`, data: signatures });
    } catch (cError: unknown) {
      log.error(cError, `Failed to apply signature to /${_id}/signatures`);
      throw new Error(`Failed to apply signature to /${_id}/signatures`);
    }
  } catch (cError: unknown) {
    log.error(cError, `Could not apply signature to resource ${_id}`);
    throw new Error(`Could not apply signature to resource ${_id}`);
  }

  log.info('signed', `Signed resource ${_id} successfully`);
  return true; // Success!
}

interface Mask {
  keys_to_mask: string[];
  generate_pdf: boolean;
}

type Shares = Array<{
  dockey: string;
  doc: { _id: string };
  tp: { _id: string };
}>;

/* Unused crap because types are not cooperating
interface SharesJob {
  type: string;
  service: string;
  config: {
    src: string;
    copy: {
      original: boolean;
      meta: {
        vdoc: boolean;
      },
      mask: Mask | boolean;
    },
    doctype: string;
    dest: string;
    user: Link;
    chroot: string;
    tree: Json;
  }
}
*/

// If the document type mismatches, move the link to the right place and let the flow start over.
// Ex: LaserFiche "unidentified" documents, FoodLogiq wrong PDF uploaded, etc.
// Note: One day we might officially separate "identification" from "transcription". This is almost that.
// TODO: Reconsider this as it doesn't really work well with jobs created outside of the helper watches
/*
async function handleResultMismatch(
  job: TargetJob,
  documentType: string,
  oada: OADAClient,
  log: Logger
) {
  const jobDocType = job.config['oada-doc-type'];
  info(
    'Document type mismatch. Job: [%s], Target: [%s]. Moving tree location and bailing.',
    documentType,
    jobDocType,
  );

  trace(`Removing from ${jobDocType} list.`);
  await oada.delete({
    path: join(
      '/bookmarks/trellisfw/documents',
      jobDocType,
      job.config.docKey,
    ),
  });

  const newType = fromOadaType(documentType)?.type;

  trace(`Updating resource type to ${newType}`);
  await oada.put({
    path: `/${job.config.document._id}`,
    data: { _type: newType },
  });
  await oada.put({
    path: join('/', job.config.document._id, '_meta'),
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

  return job.result;
}
*/
