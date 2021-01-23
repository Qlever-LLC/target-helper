import { readFileSync } from 'fs';
import Promise from 'bluebird';
import _ from 'lodash';
import oadaclient from '@oada/client';
import debug from 'debug';
import oadalist from '@oada/list-lib';
import oerror from '@overleaf/o-error'
import tree from './tree.js';

const error = debug('target-helper#asn:error');
const warn = debug('target-helper#asn:warn');
const info = debug('target-helper#asn:info');
const trace = debug('target-helper#asn:trace');
const ListWatch = oadalist.ListWatch; // not sure why I can't just import this directly

export default {
  jobHandler,
  startJobCreator,
};

//------------------------------------------------------------------------------------------------------------
// - receive the job from oada-jobs

async function jobHandler(job, { jobId, log, oada }) {
  // Link the job under the asn's _meta
  trace('Linking job under asn/_meta until oada-jobs can do that natively');
  await oada.put({ path: `/bookmarks/services/target/jobs/${jobId}/config/asn/_meta/services/target/jobs`, data: {
    [jobId]: { _ref: `resources/${jobId}` }
  }});

  return new Promise(async (resolve, reject) => {
    try {
      // There is not much for target-helper to do for an ASN job.  It just needs to
      // set the main job status to "success" or "failure" when done.
      const targetSuccess = async () => {
        log.info('helper-started', 'Target returned success, target-helper posting main success status');
        // turn off watches so our own updates don't keep coming to us
        await unwatch();
 
        log.info('done', 'Completed all helper tasks');
        return resolve(job.result);
      }

      const targetError = ({ update, key, change }) => {
        // notify oada-jobs of error    
        // post to slack if oada-jobs doesn't do that yet
        log.info('helper-error', 'Target returned error, target-helper throwing to oada/jobs');
        return reject({ message: "Target returned error: "+JSON.stringify(update,false,'  ') });
      }

      const jobChange = async c => {
        try { 
          trace('#jobChange: received change, c = ', c);
          // look through all the changes, only do things if it sends a "success" or "error" update status
          if (c.path !== '') return false; // child
          if (c.type !== 'merge') return false; // delete
          if (!c.body.updates) return false; // not an update from target
          trace('#jobChange: it is a change we want (has an update)');
          await Promise.each(_.keys(c.body.updates), async k => {
            const v = c.body.updates[k];
            trace('#jobChange: change update is: ', v);
            if (v.status && v.status === 'success') {
              trace('#jobChange: unwatching job and moving on with success tasks');
              await unwatch();
              await targetSuccess({ update: v, key: k, change: c});
            }
            if (v.status && v.status === 'error') {
                trace('#jobChange: unwatching job and moving on with error tasks');
              await unwatch();
              await targetError({ update: v, key: k, change: c});
            }
          });
        } catch(e) { reject(e); }
      }
      let watchhandle = false;
      const unwatch = async () => {
        await oada.unwatch(watchhandle);
      };
      const watch = async () => {
        if (watchhandle) { warn(`WARNING: watchhandle already exists, but watch() was called again`); }
        watchhandle = await oada.watch({ path: `/bookmarks/services/target/jobs/${jobId}`, watchCallback: jobChange });
        return await oada.get({ path: `/bookmarks/services/target/jobs/${jobId}` }).then(r=>r.data);
      };
      jobChange({ path: '', body: await watch(), type: 'merge' }); // initially just the original job is the "body" for a synthetic change
    } catch(e) { reject(e) }; // have to actually reject the promise

  });
}



//-------------------------------------------------------------------------------------------------------
// Start watching /bookmarks/trellisfw/asns and create target jobs for each new one
let con = false;
async function startJobCreator({ domain, token }) {
  try {
    con = await oadaclient.connect({domain,token});
    // ensure the thing exists because we are in charge of this endpoint
    const exists = await con.get({ path: `/bookmarks/trellisfw/asns`}).then(r=>r.status).catch(e => e.status);
    if (exists !== 200) {
      info(`/bookmarks/trellisfw/asns does not exist, creating....`);
      await con.put({path: '/bookmarks/trellisfw/asns', data: {}, tree });
    }

    const watch = new ListWatch({
      path: `/bookmarks/trellisfw/asns`,
      // Need tree and itemsPath for this to work
      tree,
      itemsPath: `$.day-index.*.*`,
      name: 'TARGET-1gdQycxI4C1QLq5QfHbF99R3wpD',
      conn: con,
      resume: true,
      onAddItem: asnAdded,
      onNewList: ListWatch.AssumeHandled, // TODO: actually check if each thing has a target job in its _meta?
      // TODO: onDeleteList
    });

  } catch(e) {
    error('ERROR: uncaught exception in watching /bookmarks/trellisfw/asns.  Error was: ', e);
  }
}



async function asnAdded(item, key) {
  info(`New ASN posted at key = `, key);

  // If this ASN's most recent job has been successfully handled by target, do not re-post it unless _meta/services/target says force
  const asnmeta = await con.get({path: `/${item._id}/_meta`}).then(r=>r.data)
    .catch(e => { throw oerror.tag(e, 'ERROR: failed to retrieve _meta for new ASN ${item._id} at key ${key}'); });

  const force = _.get(asnmeta, 'services.target.force', false);
  if (force) {
    info(`ASN at key ${key} hase _meta/services/target/force as truthy, so we will send job to target regardless of whether last job was success.`);
  }
  else if (_.has(asnmeta, 'services.target.jobs')) {
    const refslist = asnmeta.services.target.jobs;
    const jobkeys = _.keys(refslist);
    trace(`ASN at key ${key} has ${jobkeys.length} previous target jobs, checking if the last one was success.  To force, put true at /${item._id}/_meta/services/target/force`);
    const lastjobkey = _.last(jobkeys.sort()); // keys are ksuids, so they sort naturally with latest on bottom
    const lastjobid = refslist[lastjobkey]._ref;

    trace(`Retrieving last job ${lastjobid} at key ${lastjobkey}`);
    const lastjob = await con.get({ path: `/${lastjobid}` }).then(r=>r.data)
      .catch(e => { throw oerror.tag(e, 'ERROR: failed to retrieve last job ${lastjobid} at key ${lastjobkey} for ASN at key ${key}'); });

    const lastjobsuccess = _.get(lastjob, 'status', 'failure').toLowerCase() === 'success';
    if (lastjobsuccess) {
      info(`Last job for ASN ${item._id} at key ${key} has status "success" and _meta/services/target/force is not set on ASN, so we are NOT posting this to target job queue.`);
      return true;
    }
  }

  const jobkey = await con.post({path: '/resources', headers: {'content-type': 'application/vnd.oada.job.1+json'}, data: {
    type: 'asn',
    service: 'target',
    config: {
      type: 'asn',
      asn: { _id: item._id },
      documentsKey: key,
    },
  }}).then(r=>r.headers['content-location'].replace(/^\/resources\//,''))
  .catch(e => { throw oerror.tag(e, 'ERROR: failed to get a valid jobkey from content-location when posting ASN job resource, e = ') });
  trace('Posted ASN job resource, jobkey = ', jobkey);
  await con.put({path: `/bookmarks/services/target/jobs`, tree, data: {
    [jobkey]: { _id: `resources/${jobkey}` },
  }}).catch(e => { throw oerror.tag(e, 'ERROR: failed to PUT link in jobs queue for new job resources/${jobkey}') });
  info(`Posted new ASN ${item._id} at key ${key} to target job queue as job id resources/${jobkey} at key ${jobkey} in jobs queue`);
};
