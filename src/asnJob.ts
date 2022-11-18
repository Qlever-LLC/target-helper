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

import debug from 'debug';
import oError from '@overleaf/o-error';

import { type Change, connect } from '@oada/client';
import {
  type default as Job,
  assert as assertJob,
} from '@oada/types/oada/service/job.js';
import type { Json, WorkerFunction } from '@oada/jobs';
import { ListWatch } from '@oada/list-lib';
import type Update from '@oada/types/oada/service/job/update.js';
import config from './config.js';

import tree from './tree.js';

const error = debug('target-helper#asn:error');
const warn = debug('target-helper#asn:warn');
const info = debug('target-helper#asn:info');
const trace = debug('target-helper#asn:trace');

const PERSIST_INTERVAL = config.get('oada.ListWatch.persistInterval');
const pending = '/bookmarks/services/target/jobs/pending';

// ------------------------------------------------------------------------------------------------------------
// - receive the job from oada-jobs
export const jobHandler: WorkerFunction = async (job, { jobId, log, oada }) => {
  assertJob(job);

  // Link the job under the asn's _meta
  trace('Linking job under asn/_meta until oada-jobs can do that natively');
  await oada.put({
    path: `${pending}/${jobId}/config/asn/_meta/services/target/jobs`,
    data: {
      [jobId]: { _ref: `resources/${jobId}` },
    },
  });

  return new Promise(async (resolve, reject) => {
    try {
      // There is not much for target-helper to do for an ASN job.  It just needs to
      // set the main job status to "success" or "failure" when done.
      const targetSuccess = async (_arguments?: Record<string, unknown>) => {
        void log.info(
          'helper-started',
          'Target returned success, target-helper posting main success status'
        );
        // Turn off watches so our own updates don't keep coming to us
        try {
          await unwatch();
        } catch (cError: unknown) {
          // @ts-expect-error stupid errors
          if (cError.message !== 'Could not find watch state information.')
            throw cError;
        }

        void log.info('done', 'Completed all helper tasks');
        resolve(job.result as Json);
      };

      const targetError = ({
        update,
      }: {
        update: Update;
        key: string;
        change: Omit<Change, 'resource_id'>;
      }) => {
        // Notify oada-jobs of error
        // post to slack if oada-jobs doesn't do that yet
        void log.info(
          'helper-error',
          'Target returned error, target-helper throwing to oada/jobs'
        );
        // eslint-disable-next-line prefer-promise-reject-errors
        reject({
          message: `Target returned error: ${JSON.stringify(
            update,
            undefined,
            '  '
          )}`,
        });
      };

      const jobChange = async (c: Omit<Change, 'resource_id'>) => {
        try {
          trace('#jobChange: received change, c = ', c);
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
          if (!updates || typeof updates !== 'object') {
            return; // Not an update from target
          }

          trace('#jobChange: it is a change we want (has an update)');
          for (const [k, v] of Object.entries(updates)) {
            trace('#jobChange: change update is: ', v);
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
              trace(
                '#jobChange: unwatching job and moving on with error tasks'
              );
              // eslint-disable-next-line no-await-in-loop
              await unwatch();
              targetError({ update: v, key: k, change: c });
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
            `WARNING: watchhandle already exists, but watch() was called again`
          );
        }

        // eslint-disable-next-line security/detect-non-literal-fs-filename
        watchhandle = await oada.watch({
          path: `${pending}/${jobId}`,
          watchCallback: jobChange,
          type: 'single',
        });
        const { data } = await oada.get({
          path: `${pending}/${jobId}`,
        });
        return data;
      };

      const w = (await watch()) as Change['body'];
      if (Buffer.isBuffer(w))
        throw new Error('body is a buffer, cannot call jobChange');
      await jobChange({
        path: '',
        body: w,
        type: 'merge',
      }); // Initially just the original job is the "body" for a synthetic change
    } catch (cError: unknown) {
      reject(cError);
    } // Have to actually reject the promise
  });
};

// ----------------------------------------------------------------------------
// Watch /bookmarks/trellisfw/asns and create target jobs for each new one
export async function startJobCreator({
  domain,
  token,
}: {
  domain: string;
  token: string;
}) {
  try {
    const con = await connect({ domain, token });
    // Ensure the thing exists because we are in charge of this endpoint
    try {
      const { status } = await con.get({ path: `/bookmarks/trellisfw/asns` });
      if (status !== 200) {
        throw new Error('Not Found');
      }
    } catch {
      info(`/bookmarks/trellisfw/asns does not exist, creating...`);
      await con.put({ path: '/bookmarks/trellisfw/asns', data: {}, tree });
    }

    // eslint-disable-next-line no-inner-declarations
    async function asnAdded(item: { _id: string }, key: string): Promise<void> {
      info(`New ASN posted at key = %s`, key);
      try {
        // If this ASN's most recent job has been successfully handled by target, do not re-post it unless _meta/services/target says force
        const { data: asnmeta } = await con.get({
          path: `/${item._id}/_meta`,
        });

        const { services = {} } = asnmeta as {
          services?: {
            target?: {
              force?: boolean;
              jobs?: Record<string, { _ref?: string }>;
            };
          };
        };
        if (services?.target?.force) {
          info(
            'ASN at key %s has _meta/services/target/force as truthy, so we will send job to target regardless of whether last job was success.',
            key
          );
        } else if (services?.target?.jobs) {
          const refslist = services.target.jobs;
          const jobEntries = Object.entries(refslist);
          trace(
            'ASN at key %s has %d previous target jobs, checking if the last one was success. To force, put true at /%s/_meta/services/target/force',
            key,
            jobEntries.length,
            item._id
          );
          // Keys are ksuids, so they sort naturally with latest on bottom
          const [lastJobKey, lastReference] = jobEntries
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .pop()!;
          const lastJobID = lastReference?._ref;

          trace('Retrieving last job %s at key %s', lastJobID, lastJobKey);
          try {
            const { data: lastjob } = (await con.get({
              path: `/${lastJobID}`,
            })) as {
              data: Job | undefined;
            };

            const lastjobsuccess = lastjob?.status?.toLowerCase() === 'success';
            if (lastjobsuccess) {
              info(
                'Last job for ASN %s at key %s has status "success" and _meta/services/target/force is not set on ASN, so we are NOT posting this to target job queue.',
                item._id,
                key
              );
              // Return true;
              return;
            }
          } catch (cError: unknown) {
            throw oError.tag(
              cError as Error,
              `ERROR: failed to retrieve last job ${lastJobID} at key ${lastJobKey} for ASN at key ${key}`
            );
          }
        }
      } catch (cError: unknown) {
        throw oError.tag(
          cError as Error,
          `ERROR: failed to retrieve _meta for new ASN ${item._id} at key ${key}`
        );
      }

      let jobkey;
      try {
        const {
          headers: { 'content-location': location },
        } = await con.post({
          path: '/resources',
          contentType: 'application/vnd.oada.job.1+json',
          data: {
            type: 'asn',
            service: 'target',
            config: {
              type: 'asn',
              asn: { _id: item._id },
              documentsKey: key,
            },
          },
        });
        jobkey = location!.replace(/^\/resources\//, '');
      } catch (cError: unknown) {
        throw oError.tag(
          cError as Error,
          'ERROR: failed to get a valid jobkey from content-location when posting ASN job resource'
        );
      }

      trace('Posted ASN job resource, jobkey = %s', jobkey);
      try {
        await con.put({
          path: `${pending}`,
          tree,
          data: {
            [jobkey]: { _id: `resources/${jobkey}` },
          },
        });
      } catch (cError: unknown) {
        throw oError.tag(
          cError as Error,
          `ERROR: failed to PUT link in jobs queue for new job resources/${jobkey}`
        );
      }

      info(
        'Posted new ASN %s at key %s to target job queue as job id resources/%s at key %s in jobs queue',
        item._id,
        key,
        jobkey,
        jobkey
      );
    }

    // eslint-disable-next-line no-new
    new ListWatch({
      path: `/bookmarks/trellisfw/asns`,
      // Need tree and itemsPath for this to work
      itemsPath: `$.day-index.*.*`,
      name: 'TARGET-1gdQycxI4C1QLq5QfHbF99R3wpD',
      conn: con,
      resume: true,
      onAddItem: asnAdded,
      // TODO: actually check if each thing has a target job in its _meta?
      onNewList: ListWatch.AssumeHandled,
      // TODO: onDeleteList
      persistInterval: PERSIST_INTERVAL
    });
  } catch (cError: unknown) {
    error(cError, 'uncaught exception in watching /bookmarks/trellisfw/asns');
  }
}