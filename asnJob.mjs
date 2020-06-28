import { readFileSync } from 'fs';
import Promise from 'bluebird';
import _ from 'lodash';
import oadaclient from '@oada/client';
import debug from 'debug';
import tree from './tree.js';

const error = debug('target-helper#asn:error');
const warn = debug('target-helper#asn:warn');
const info = debug('target-helper#asn:info');
const trace = debug('target-helper#asn:trace');

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
async function startJobCreator({ domain, token }) {
  try {
    const con = await oadaclient.connect({domain,token});
    // ensure the thing exists
    const exists = await con.get({ path: `/bookmarks/trellisfw/asns`}).then(r=>r.status).catch(e => e.status);
    if (exists !== 200) {
      info(`/bookmarks/trellisfw/asn-staging does not exist, creating....`);
      await con.put({path: '/bookmarks/trellisfw/asns', data: {}, tree });
    }
  
    await con.get({ path: `/bookmarks/trellisfw/asns`, watchCallback: async function handleDocChange(c) {
      if (c.path !== '') return; // not a change to root resource
      if (c.type !== 'merge') return;
      // Is there a non-oada key (i.e. a link) in here?
      const keys = _.filter(_.keys(c.body), k => !k.match(/^_/));
      if (keys.length < 1) return;
      // Have a real key that could be a new doc link, check if _id is in the link (that means it's a new link)
      await Promise.each(keys, async k => {
        const v = c.body[k];
        if (!v || !v._id) return; // not a link
        // Otherwise, it is a new link, post a job to ourselves
        trace('RECEIVED NEW ASN DOCUMENT: ', v._id);
        const jobkey = await con.post({path: '/resources', headers: {'content-type': 'application/vnd.oada.job.1+json'}, data: {
          type: 'asn',
          service: 'target',
          config: {
            type: 'asn',
            asn: { _id: v._id },
            documentsKey: k,
          },
        }}).then(r=>r.headers['content-location'].replace(/^\/resources\//,''))
        .catch(e => error('ERROR: failed to get jobkey when posting ASN job resource, e = ', e));
        info('Posted ASN job resource, jobkey = ', jobkey);
        await con.put({path: `/bookmarks/services/target/jobs`, tree, data: {
          [jobkey]: { _id: `resources/${jobkey}` },
        }});
        trace('Posted new ASN to target job queue');
      });
    }});
  } catch(e) {
    error('ERROR: uncaught exception in watching /bookmarks/trellisfw/asns.  Error was: ', e);
  }
}
