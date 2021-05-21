import _ from 'lodash';
import debug from 'debug';
import oerror from '@overleaf/o-error';

import { connect, Change } from '@oada/client';
import { ListWatch } from '@oada/list-lib';
import { Job, assert as assertJob } from '@oada/types/oada/service/job';
import type Update from '@oada/types/oada/service/job/update';
import type { WorkerFunction } from '@oada/jobs';

import tree from './tree.js';

const error = debug('target-helper#asn:error');
const warn = debug('target-helper#asn:warn');
const info = debug('target-helper#asn:info');
const trace = debug('target-helper#asn:trace');

//------------------------------------------------------------------------------------------------------------
// - receive the job from oada-jobs

export const jobHandler: WorkerFunction = async (job, { jobId, log, oada }) => {
  assertJob(job);

  // Link the job under the asn's _meta
  trace('Linking job under asn/_meta until oada-jobs can do that natively');
  await oada.put({
    path: `/bookmarks/services/target/jobs/${jobId}/config/asn/_meta/services/target/jobs`,
    data: {
      [jobId]: { _ref: `resources/${jobId}` },
    },
  });

  return await new Promise(async (resolve, reject) => {
    try {
      // There is not much for target-helper to do for an ASN job.  It just needs to
      // set the main job status to "success" or "failure" when done.
      const targetSuccess = async (_args?: {}) => {
        log.info(
          'helper-started',
          'Target returned success, target-helper posting main success status'
        );
        // turn off watches so our own updates don't keep coming to us
        await unwatch();

        log.info('done', 'Completed all helper tasks');
        return resolve(job.result as any);
      };

      const targetError = ({
        update,
      }: {
        update: Update;
        key: string;
        change: Omit<Change, 'resource_id'>;
      }) => {
        // notify oada-jobs of error
        // post to slack if oada-jobs doesn't do that yet
        log.info(
          'helper-error',
          'Target returned error, target-helper throwing to oada/jobs'
        );
        return reject({
          message:
            'Target returned error: ' + JSON.stringify(update, null, '  '),
        });
      };

      const jobChange = async (c: Omit<Change, 'resource_id'>) => {
        try {
          trace('#jobChange: received change, c = ', c);
          // look through all the changes, only do things if it sends a "success" or "error" update status
          if (c.path !== '') {
            return false; // child
          }
          if (c.type !== 'merge') {
            return false; // delete
          }
          // @ts-ignore
          const { updates } = c.body ?? {};
          if (!updates) {
            return false; // not an update from target
          }
          trace('#jobChange: it is a change we want (has an update)');
          for (const [k, v] of Object.entries<Update>(updates)) {
            trace('#jobChange: change update is: ', v);
            if (v.status === 'success') {
              trace(
                '#jobChange: unwatching job and moving on with success tasks'
              );
              await unwatch();
              // TODO: Why pass stuff to this function with no arguments?
              await targetSuccess({ update: v, key: k, change: c });
            }
            if (v.status === 'error') {
              trace(
                '#jobChange: unwatching job and moving on with error tasks'
              );
              await unwatch();
              targetError({ update: v, key: k, change: c });
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
            `WARNING: watchhandle already exists, but watch() was called again`
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
      jobChange({ path: '', body: await watch(), type: 'merge' }); // initially just the original job is the "body" for a synthetic change
    } catch (e) {
      reject(e);
    } // have to actually reject the promise
  });
};

//-------------------------------------------------------------------------------------------------------
// Start watching /bookmarks/trellisfw/asns and create target jobs for each new one
export async function startJobCreator({
  domain,
  token,
}: {
  domain: string;
  token: string;
}) {
  try {
    const con = await connect({ domain, token });
    // ensure the thing exists because we are in charge of this endpoint
    const exists = await con
      .get({ path: `/bookmarks/trellisfw/asns` })
      .then((r) => r.status)
      .catch((e) => e.status);
    if (exists !== 200) {
      info(`/bookmarks/trellisfw/asns does not exist, creating....`);
      await con.put({ path: '/bookmarks/trellisfw/asns', data: {}, tree });
    }

    new ListWatch({
      path: `/bookmarks/trellisfw/asns`,
      // Need tree and itemsPath for this to work
      tree,
      itemsPath: `$.day-index.*.*`,
      name: 'TARGET-1gdQycxI4C1QLq5QfHbF99R3wpD',
      conn: con,
      resume: true,
      onAddItem: asnAdded,
      // TODO: actually check if each thing has a target job in its _meta?
      onNewList: ListWatch.AssumeHandled,
      // TODO: onDeleteList
    });

    async function asnAdded(item: { _id: string }, key: string): Promise<void> {
      info(`New ASN posted at key = %s`, key);

      // If this ASN's most recent job has been successfully handled by target, do not re-post it unless _meta/services/target says force
      const asnmeta = (await con
        .get({ path: `/${item._id}/_meta` })
        .then((r) => r.data)
        .catch((e) => {
          throw oerror.tag(
            e,
            'ERROR: failed to retrieve _meta for new ASN ${item._id} at key ${key}'
          );
        })) as any;

      if (asnmeta?.services?.target?.force) {
        info(
          'ASN at key %s has _meta/services/target/force as truthy, so we will send job to target regardless of whether last job was success.',
          key
        );
      } else if (asnmeta?.services?.target?.jobs) {
        const refslist = asnmeta.services.target.jobs;
        const jobkeys = Object.keys(refslist);
        trace(
          'ASN at key %s has %d previous target jobs, checking if the last one was success. To force, put true at /%s/_meta/services/target/force',
          key,
          jobkeys.length,
          item._id
        );
        // keys are ksuids, so they sort naturally with latest on bottom
        const lastjobkey = _.last(jobkeys.sort())!;
        const lastjobid = refslist[lastjobkey]._ref;

        trace('Retrieving last job %s at key %s', lastjobid, lastjobkey);
        const lastjob = (await con
          .get({ path: `/${lastjobid}` })
          .then((r) => r.data)
          .catch((e) => {
            throw oerror.tag(
              e,
              'ERROR: failed to retrieve last job ${lastjobid} at key ${lastjobkey} for ASN at key ${key}'
            );
          })) as Job;

        const lastjobsuccess = lastjob?.status?.toLowerCase() === 'success';
        if (lastjobsuccess) {
          info(
            'Last job for ASN %s at key %s has status "success" and _meta/services/target/force is not set on ASN, so we are NOT posting this to target job queue.',
            item._id,
            key
          );
          //return true;
          return;
        }
      }

      const jobkey = await con
        .post({
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
        })
        .then((r) =>
          r.headers['content-location']!.replace(/^\/resources\//, '')
        )
        .catch((e) => {
          throw oerror.tag(
            e,
            'ERROR: failed to get a valid jobkey from content-location when posting ASN job resource, e = '
          );
        });
      trace('Posted ASN job resource, jobkey = %s', jobkey);
      await con
        .put({
          path: `/bookmarks/services/target/jobs`,
          tree,
          data: {
            [jobkey]: { _id: `resources/${jobkey}` },
          },
        })
        .catch((e) => {
          throw oerror.tag(
            e,
            'ERROR: failed to PUT link in jobs queue for new job resources/${jobkey}'
          );
        });
      info(
        'Posted new ASN %s at key %s to target job queue as job id resources/%s at key %s in jobs queue',
        item._id,
        key,
        jobkey,
        jobkey
      );
    }
  } catch (e) {
    error('uncaught exception in watching /bookmarks/trellisfw/asns: %O', e);
  }
}
