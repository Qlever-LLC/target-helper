import { readFileSync } from 'fs';
import Promise from 'bluebird';
import _ from 'lodash';
import debug from 'debug';
import Jobs from '@oada/jobs';
import tsig from '@trellisfw/signatures';
import tree from './tree';

import config from './config.js'

const { Service } = Jobs; // no idea why I have to do it this way

const error = debug('target-helper:error');
const warn = debug('target-helper:warn');
const info = debug('target-helper:info');
const trace = debug('target-helper:trace');

// You can generate a signing key pair by running `oada-certs --create-keys`
const prvKey = JSON.parse(readFileSync(config.get('privateJWK')));
const pubKey = tsig.keys.pubFromPriv(prvKey);
const header = { jwk: pubKey };
if (prvKey.jku) header.jku = prvKey.jku; // make sure we keep jku and kid
if (prvKey.kid) header.kid = prvKey.kid;
const signer = config.get('signer');
const signatureType = config.get('signatureType');

const TOKEN = config.get('token');
let DOMAIN = config.get('domain') || '';
if (DOMAIN.match(/^http/)) DOMAIN = DOMAIN.replace(/^https:\/\//, '');

if (DOMAIN === 'localhost') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;
}


const service = new Service('target', DOMAIN, TOKEN, 1); // 1 concurrent job

// 5 min timeout
service.on('pdf', 5*60*1000, newJob);

// `target-helper` will fill in around this
// - receive the job from oada-jobs
async function newJob(job, { jobId, log, oada }) {
  return new Promise(async (resolve, reject) => {
    // - once it sees "success" in the updates, it will post a job to trellis-signer and notify oada-jobs of success
    const targetSuccess = () => {
      log.info('helper-started', 'Target returned success, target-helper picking up');
      
      // cross link vdoc for pdf <-> audits,cois,lettters,etc.
      log.info('helper: linking result _refs under <pdf>/_meta/vdoc');
      const pdfid = job.config.pdf._id;
      function recursiveReplaceLinksWithRefs(obj) {
        if (!obj || typeof obj !== 'object') return obj;
        if (obj._id) return { _ref: obj._id };
        return _.reduce(obj, (acc,v,k) => {
          acc[k] = recursiveReplaceLinksWithRefs(obj[k]);
          return acc;
        });
      }
      await oada.put({ path: `/${pdfid}/_meta`, data: {
        vdoc: recursiveReplaceLinksWithRefs(job.result), // fsqa-audits { ...links... }, or fsqa-certificates { ...links... }, etc.
      });

      // Look through all the things in result recursively, if any are links then go there and set _meta/vdoc/pdf
      log.info('helper: linking _meta/vdoc/pdf for each link in result');
      async function recursivePutVdocAtLinks(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (obj._id) {
          return oada.put({ path: `/${obj._id}/_meta`, data: {
            vdoc: { pdf: { _ref: `/${pdfid}` } }
          }});
        }
        return Promise.each(_.keys(obj), k => recursivePutVdocAtLinks(obj[k]));
      }
      await recursivePutVdocAtLinks(job.result);

      // sign audit/coi/etc.
      log.info('helper: signing all links in result');
      async function recursiveSignLinks(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (obj._id) return signResourceForTarget({ _id: obj._id, oada, log });
        return Promise.each(_.keys(obj), k => recursiveSignLinks(obj[k]));
      }
      await recursiveSignLinks(job.result);

      // put audits/cois/etc. to proper home
      function recursiveMakeAllLinksVersioned(obj) {
        if (!obj || typeof obj !== 'object') return obj;
        if (obj._id) return { _id: obj._id, _rev: 0 };
        return _.reduce(obj, (acc,v,k) => {
          acc[k] = recursiveMakeAllLinksVersioned(obj[k]);
          return acc;
        });
      }
      const versionedResult = recursiveMakeAllLinksVersioned(job.result);
      await Promise.each(_.keys(versionedResult), async doctype => { // top-level keys are doc types
        log.info('linking', `Linking doctype ${doctype} from result`):
        // Automatically augment the base tree with the right content-type
        tree.bookmarks.trellisfw[doctype] = { _type: `application/vnd.trellisfw.${doctype}.1+json` };
        await oada.put({ path: `/bookmarks/trellisfw/${doctype}`, data: versionedResult[doctype], tree });
      });

      // HARDCODED UNTIL AINZ IS UPDATED:
      // lookup shares, post job to shares service
      await Promise.each(_.keys(job.result), async doctype => {
        const shares = [];
        const doclist = job.result[doctype];
        await Promise.each(_.keys(doclist), dockey => {
          const doc = doclist[dockey];
          const lookups = await oada.get({ path: `/${doc._id}/_meta/lookups` });
          switch (doctype) {
            case 'fsqa-audits': 
            case 'fsqa-certificates': 
              const facility = await oada.get({ path: `/${lookups.organization._ref}` });
              // TODO: lookup all the trading partners based on facility.  Will do when COI is done and working
              throw new Error('Facility lookup for trading partners from audits and certificates not yet implemented!');
            break;
            case 'cois': 
              const holder = await oada.get({ path: `/${lookups.holder._ref}` });
              await Promise.each(_.keys(holder['trading-partners']), async tplinkkey => {
                const tplink = holder['trading-partners'][tplinkkey];
                const tp = await oada.get({ path: `/${tplink._ref}` });
                shares.push({ tp, doc, dockey });
            break;
            case 'letters-of-guarantee':
              // TODO: handle these lookups too
              throw new Error('Lookups for letters-of-guarantee not implemented!');
            break;
          }
        }
        log.info('sharing', `Posting ${shares.length} shares jobs for doctype ${doctype} resulting from this transcription`);
        await Promise.each(shares, async s => {
          const {dockey, doc, tp} = s;
          const tpkey = tp._id.replace(/^resources\//,'');
          await resid = oada.post({ path: `/resources`, headers: { 'content-type': tree.bookmarks.services['*'].jobs['*']._type }, data: {
            type: 'share-user',
            config: {
              src: { _id: doc._id },
              doctype, // fsqa-audits, cois, fsqa-certificates, trading-partners
              userdest: `/bookmarks/trellisfw/${doctype}/${dockey}`,
              userbookmarks: `/bookmarks/trellisfw/trading-partners/${tpkey}`,
            },
          }}).then(r=>r.headers['content-location'].replace(/^\//,''));
          const jobpath = await oada.post( { path: `/bookmarks/services/shares/jobs`, data: { _id: resid, _rev: 0 }, tree }).then(r=>r.headers['content-location']);
          const jobid = jobpath.replace(/^\/resources\/[^\/]+\/,'');
          trace('Posted jobid ',jobid, ' for shares');
        });
      });

      log.info('done', 'Completed all helper tasks');
      return job.result;
      
    }
    const targetError = ({ update, key, change }) => {
      // notify oada-jobs of error    
      // post to slack if oada-jobs doesn't do that yet
      log.info('helper-error', 'Target returned error, target-helper throwing to oada/jobs');
      return reject("Target returned error: "+JSON.stringify(update,false,'  '));
    }
    const jobChange = async c => {
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
    }
    const unwatch = async () => await oada.get({ path: `/bookmarks/services/target/jobs/${jobId}`, unwatch: true });
    const watch = async () => await oada.get({ path: `/bookmarks/services/target/jobs/${jobId}`, watchCallback: jobChange }).then(r=>r.data);
    jobChange({ path: '', body: await watch(), type: 'merge' }); // initially just the original job is the "body" for a synthetic change

  //
  // - once it sees "success" in the updates, it will post a job to trellis-signer and notify oada-jobs of success
  // - if it sees "error" in the updates, it will notify oada-jobs of error
  // - In the caes of PDF, it will cross-link from the PDF in meta to the resulting fsqa-certificates (etc.): i.e. the
  //   "result" object should just go in meta/vdoc, except all id's should be ref's
  // - If oada-jobs doesn't have Slack posting, be sure to post to slack manually until that time

  });
}



async function signResourceForTarget({ _id, oada, log }) {  
  const r = await oada.get({ path: `/${_id}` }).then(r=>r.data);
  let a = _.cloneDeep(r); // the actual audit or coi json

  try {
    // Test first if this thing already has a transcription signature.  If so, skip it.
    trace('#signResourceForTarget: Checking for existing ' signature...');
    async function hasTranscriptionSignature(res) {
      if (!res.signatures) return false;
      const { trusted, valid, unchanged, payload, original, details } = await tsig.verify(res);
      trace(`#signResourceForTarget: Checked for signature, got back trusted ${trusted} valid ${valid} unchanged ${unchanged} payload ${payload}`);
      if (payload && payload.type === signatureType) return true; // Found one!
      if (original) return hasTranscriptionSignature(original);
      return false; // shouldn't ever get here.
    }
    if (await hasTranscriptionSignature(a)) {
      log.warn(`#signResourceForTarget: Item ${_id} already has a transcription signature on it, choose to skip it and not apply a new one`);
      return true;
    }
    trace('#signResourceForTarget: Did not find existing '+type+' signature, signing...');

    // Otherwise, go ahead and apply the signature
    a = await tsig.sign(a, prvKey, { header, signer, type });
  } catch (e) {
    error(`Could not apply signature to resource ${_id}, err = %O`, e);
    throw new Error(`Could not apply signature to resource ${_id}`);
  }

  info(`PUTing signed signatures key only to /${_id}/signatures`);
  await oada.put({ path: `/${_id}/signatures`, data: a.signatures, });
  .catch(e => {
    error(`Failed to apply signature to /${_id}/signatures, error = `, e);
    throw new Error(`Failed to apply signature to /${_id}/signatures`);
  }
  log.info('signed', `Signed resource ${_id} successfully`);
  return true; // success!
}


service.start().catch(e => 
  console.error('Service threw uncaught error: ',e)
);
