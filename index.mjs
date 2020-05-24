import { readFileSync } from 'fs';
import Promise from 'bluebird';
import _ from 'lodash';
import debug from 'debug';
import Jobs from '@oada/jobs';
import oadaclient from '@oada/client';
import tsig from '@trellisfw/signatures';
import tree from './tree.js';

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


const service = new Service('target', DOMAIN, TOKEN, 1, { 
  finishReporters: [ 
    { 
      type: 'slack', 
      status: 'failure', 
      posturl: config.get('slackposturl'),
    } 
  ]
}); // 1 concurrent job

// 5 min timeout
service.on('transcription', config.get('timeout'), newJob);

// `target-helper` will fill in around this
// - receive the job from oada-jobs
async function newJob(job, { jobId, log, oada }) {
  // until oada-jobs adds cross-linking, make sure we are linked under pdf's jobs
  trace('Linking job under pdf/_meta until oada-jobs can do that natively');
  await oada.put({ path: `/bookmarks/services/target/jobs/${jobId}/config/pdf/_meta/services/target/jobs`, data: {
    [jobId]: { _ref: `resources/${jobId}` }
  }});

  return new Promise(async (resolve, reject) => {
    try {
      // - once it sees "success" in the updates, it will post a job to trellis-signer and notify oada-jobs of success
      const targetSuccess = async () => {
        log.info('helper-started', 'Target returned success, target-helper picking up');
        // turn off watches so our own updates don't keep coming to us
        await unwatch();
        // Get the latest copy of job
        const job = await oada.get({ path: `/resources/${jobId}` }).then(r=>r.data);
        
        // ------------- 1: cross link vdoc for pdf <-> audits,cois,lettters,etc.
        log.info('link-refs-pdf', 'helper: linking result _refs under <pdf>/_meta/vdoc');
        const pdfid = job.config.pdf._id;
        function recursiveReplaceLinksWithRefs(obj) {
          if (!obj || typeof obj !== 'object') return obj;
          if (obj._id) return { _ref: obj._id };
          return _.reduce(obj, (acc,v,k) => {
            acc[k] = recursiveReplaceLinksWithRefs(obj[k]);
            return acc;
          },{});
        }
        trace('Linking _ref\'s into pdf/_meta, job.result before refs is: ',job.result,', and after refs replacement is ',  recursiveReplaceLinksWithRefs(job.result));
        await oada.put({ path: `/${pdfid}/_meta`, data: {
          vdoc: recursiveReplaceLinksWithRefs(job.result), // fsqa-audits { ...links... }, or fsqa-certificates { ...links... }, etc.
        }});
  
        // ------------- 2: Look through all the things in result recursively, if any are links then go there and set _meta/vdoc/pdf
        log.info('helper: linking _meta/vdoc/pdf for each link in result');
        async function recursivePutVdocAtLinks(obj) {
          if (!obj || typeof obj !== 'object') return;
          if (obj._id) {
            return await oada.put({ path: `/${obj._id}/_meta`, data: {
              vdoc: { pdf: { _id: `${pdfid}` } }
            }});
          }
          return Promise.each(_.keys(obj), k => recursivePutVdocAtLinks(obj[k]));
        }
        await recursivePutVdocAtLinks(job.result);
  
        // ------------- 3: sign audit/coi/etc.
        log.info('helper: signing all links in result');
        async function recursiveSignLinks(obj) {
          if (!obj || typeof obj !== 'object') return;
          if (obj._id) return signResourceForTarget({ _id: obj._id, oada, log });
          return Promise.each(_.keys(obj), k => recursiveSignLinks(obj[k]));
        }
        await recursiveSignLinks(job.result);
  
        // ------------- 4: put audits/cois/etc. to proper home
        function recursiveMakeAllLinksVersioned(obj) {
          if (!obj || typeof obj !== 'object') return obj;
          if (obj._id) return { _id: obj._id, _rev: 0 };
          return _.reduce(obj, (acc,v,k) => {
            acc[k] = recursiveMakeAllLinksVersioned(obj[k]);
            return acc;
          }, {});
        }
        const versionedResult = recursiveMakeAllLinksVersioned(job.result);
        trace(`all versioned links to bookmarks = `, versionedResult);
        await Promise.each(_.keys(versionedResult), async doctype => { // top-level keys are doc types
          log.info('linking', `Linking doctype ${doctype} from result`);
          // Automatically augment the base tree with the right content-type
          tree.bookmarks.trellisfw[doctype] = { _type: `application/vnd.trellis.${doctype}.1+json` };
          await oada.put({ path: `/bookmarks/trellisfw/${doctype}`, data: versionedResult[doctype], tree });
        });

        //-------------- 5: unlink PDF from unidentified documents
        if (!job.config.bookmarksPath) {
          warn(`WARNING: job had no bookmarksPath, cannot unlink PDF`);
        } else {
          log.info(`unlinking-pdf`, `Unlinking PDF from ${job.config.bookmarksPath} now that it is no longer unidentified`);
          await oada.delete({ path: job.config.bookmarksPath });
        }
  
        // HARDCODED UNTIL AINZ IS UPDATED:
        // ------------- 6: lookup shares, post job to shares service
        await Promise.each(_.keys(job.result), async doctype => {
          const shares = [];
          const doclist = job.result[doctype];
          await Promise.each(_.keys(doclist), async dockey => {
            const doc = doclist[dockey];
            trace(`Fetching lookups for doctype = ${doctype}, doc = `,doc,`, getting /${doc._id}/_meta/lookups`);
            const lookups = await oada.get({ path: `/${doc._id}/_meta/lookups` }).then(r=>r.data);
            trace(`lookups = `, lookups);
            let facility;
            switch (doctype) {
              case 'fsqa-audits': 
                facility = await oada.get({ path: `/${lookups['fsqa-audit'].organization._ref}` });
                // TODO: lookup all the trading partners based on facility.  Will do when COI is done and working
                throw new Error('Facility lookup for trading partners from audits and certificates not yet implemented!');
              case 'fsqa-certificates': 
                facility = await oada.get({ path: `/${lookups['fsqa-certificate'].organization._ref}` });
                // TODO: lookup all the trading partners based on facility.  Will do when COI is done and working
                throw new Error('Facility lookup for trading partners from audits and certificates not yet implemented!');
              break;
              case 'cois': 
                const holder = await oada.get({ path: `/${lookups.coi.holder._ref}` }).then(r=>r.data);
                trace(`Retrieved holder `, holder);
                await Promise.each(_.keys(holder['trading-partners']), async tplinkkey => {
                  const tplink = holder['trading-partners'][tplinkkey];
                  const tp = await oada.get({ path: `/${tplink._id}` }).then(r=>r.data);
                  shares.push({ tp, doc, dockey });
                });
              break;
              case 'letters-of-guarantee':
                // TODO: handle these lookups too
                throw new Error('Lookups for letters-of-guarantee not implemented!');
              break;
            }
          });
          log.info('sharing', `Posting ${shares.length} shares jobs for doctype ${doctype} resulting from this transcription`);
          await Promise.each(shares, async s => {
            const {dockey, doc, tp} = s;
            const tpkey = tp._id.replace(/^resources\//,'');
            const user = await oada.get({ path: `/${tp._id}/user` }).then(r=>r.data);
            const resid = await oada.post({ path: `/resources`, headers: { 'content-type': tree.bookmarks.services['*'].jobs['*']._type }, data: {
              type: 'share-user-link',
              service: 'trellis-shares',
              config: {
                src: `/${doc._id}`,
                doctype, // fsqa-audits, cois, fsqa-certificates, trading-partners
                dest: `/bookmarks/trellisfw/${doctype}/${dockey}`, // this doubles-up bookmarks, but I think it's the most understandable to look at
                user, // { id, bookmarks }
                chroot: `/bookmarks/trellisfw/trading-partners/${tpkey}/user/bookmarks`,
                tree: treeForDocType(doctype),
              },
            }}).then(r=>r.headers['content-location'].replace(/^\//,''));
            const reskey = resid.replace(/^resources\//,'');
            trace('Shares job posted as resid = ', resid);
            const jobpath = await oada.put( { path: `/bookmarks/services/trellis-shares/jobs`, data: { [reskey]: { _id: resid, _rev: 0 } }, tree }).then(r=>r.headers['content-location']);
            const jobkey = jobpath.replace(/^\/resources\/[^\/]+\//,'');
            trace('Posted jobkey ',jobkey, ' for shares');
          });
        });
  
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
      const unwatch = async () => await oada.get({ path: `/bookmarks/services/target/jobs/${jobId}`, unwatch: true });
      const watch = async () => await oada.get({ path: `/bookmarks/services/target/jobs/${jobId}`, watchCallback: jobChange }).then(r=>r.data);
      jobChange({ path: '', body: await watch(), type: 'merge' }); // initially just the original job is the "body" for a synthetic change
    } catch(e) { reject(e) }; // have to actually reject the promise

  });
}



async function signResourceForTarget({ _id, oada, log }) {  
  const r = await oada.get({ path: `/${_id}` }).then(r=>r.data);
  let a = _.cloneDeep(r); // the actual audit or coi json

  try {
    // Test first if this thing already has a transcription signature.  If so, skip it.
    trace('#signResourceForTarget: Checking for existing signature...');
    async function hasTranscriptionSignature(res) {
      if (!res.signatures) return false;
      const { trusted, valid, unchanged, payload, original, details } = await tsig.verify(res);
      trace(`#signResourceForTarget: Checked for signature, got back trusted ${trusted} valid ${valid} unchanged ${unchanged} payload ${payload}`);
      if (payload && payload.type === signatureType) return true; // Found one!
      if (original) return hasTranscriptionSignature(original);
      return false; // shouldn't ever get here.
    }
    if (await hasTranscriptionSignature(a)) {
      log.error(`#signResourceForTarget: Item ${_id} already has a transcription signature on it, choose to skip it and not apply a new one`);
      return true;
    }
    trace('#signResourceForTarget: Did not find existing '+signatureType+' signature, signing...');

    // Otherwise, go ahead and apply the signature
    a = await tsig.sign(a, prvKey, { header, signer, type: signatureType });
  } catch (e) {
    error(`Could not apply signature to resource ${_id}, err = %O`, e);
    throw new Error(`Could not apply signature to resource ${_id}`);
  }

  info(`PUTing signed signatures key only to /${_id}/signatures`);
  await oada.put({ path: `/${_id}/signatures`, data: a.signatures, })
  .catch(e => {
    error(`Failed to apply signature to /${_id}/signatures, error = `, e);
    throw new Error(`Failed to apply signature to /${_id}/signatures`);
  });
  log.info('signed', `Signed resource ${_id} successfully`);
  return true; // success!
}



function treeForDocType(doctype) {
  let singularType = doctype;
  if (singularType.match(/s$/)) singularType.replace(/s$/,''); // if it ends in 's', easy fix
  else if (singularType.match(/-/)) { // if it has a dash, maybe it is like letters-of-guarantee (first thing plural)
    const parts = _.split(singularType, '-');
    if (parts[0] && parts[0].match(/s$/)) {
      parts[0] = parts[0].replace(/s$/,'');
    } else {
      throw new Error(`ERROR: doctype ${doctype} has dashes, but is not easily convertible to singular word for _type`);
    }
    singularType = _.join(parts, '-');
  } else {
    throw new Error(`ERROR: doctype ${doctype} is not easily convertible to singular word for _type`);
  }
  return {
    bookmarks: {
      _type: 'application/vnd.oada.bookmarks.1+json',
      trellisfw: {
        _type: 'application/vnd.trellis.1+json',
        [doctype]: { // cois, fsqa-audits, etc.
          _type: `application/vnd.trellis.${doctype}.1+json`, // plural word: cois, letters-of-guarantee
          '*': {
            _type: `application/vnd.trellis.${singularType}.1+json`, // coi, letter-of-guarantee
          }
        }
      }
    }
  };
}

service.start().catch(e => 
  console.error('Service threw uncaught error: ',e)
);


// also start watching /bookmarks/trellisfw/documents and create target jobs for each new one
// until ainz can do that for us
oadaclient.connect({domain: DOMAIN,token: TOKEN})
.then(async con => {
  // ensure the thing exists
  const exists = await con.get({ path: `/bookmarks/trellisfw/documents`}).then(r=>r.status).catch(e => e.status);
  if (exists !== 200) {
    info(`/bookmarks/trellisfw/documents does not exist, creating....`);
    await con.put({path: '/bookmarks/trellisfw/documents', data: {}, tree });
  }

  await con.get({ path: `/bookmarks/trellisfw/documents`, watchCallback: async function handleDocChange(c) {
    if (c.path !== '') return; // not a change to root resource
    if (c.type !== 'merge') return;
    // Is there a link in here?
    const keys = _.filter(_.keys(c.body), k => !k.match(/^\//));
    if (keys.length < 1) return;
    // Have a real key that could be a new doc link, check if _id is in the link (that means it's a new link)
    await Promise.each(keys, async k => {
      const v = c.body[k];
      if (!v || !v._id) return; // not a link
      // Otherwise, it is a new link, post a job to ourselves
      info('RECEIVED NEW PDF DOCUMENT: ', v._id);
      const jobkey = await con.post({path: '/resources', headers: {'content-type': 'application/vnd.oada.job.1+json'}, data: {
        type: 'transcription',
        service: 'target',
        config: {
          type: 'pdf',
          pdf: { _id: v._id },
          bookmarksPath: `/bookmarks/trellisfw/documents/${k}`,
        },
      }}).then(r=>r.headers['content-location'].replace(/^\/resources\//,''))
      .catch(e => error('ERROR: failed to get jobkey when posting job resource, e = ', e));
      console.log('Posted job resource, jobkey = ', jobkey);
      await con.put({path: `/bookmarks/services/target/jobs`, tree, data: {
        [jobkey]: { _id: `resources/${jobkey}` },
      }});
      trace('Posted new PDF document to target task queue');
    });
  }});
}).catch(e => error('ERROR: unchaught exception in watching /bookmarks/trellisfw/documents.  Error was: ', e));
