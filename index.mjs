import { readFileSync } from 'fs';
import Promise from 'bluebird';
import _ from 'lodash';
import debug from 'debug';
import Jobs from '@oada/jobs';
import oadaclient from '@oada/client';
import tsig from '@trellisfw/signatures';
import tree from './tree.js';
import pdf from './pdfJob.mjs';
import asn from './asnJob.mjs';

import config from './config.mjs'

const { Service } = Jobs; // no idea why I have to do it this way

const error = debug('target-helper#pdf:error');
const warn = debug('target-helper#pdf:warn');
const info = debug('target-helper#pdf:info');
const trace = debug('target-helper#pdf:trace');

const token = config.get('token');
let domain = config.get('domain') || '';
if (domain.match(/^http/)) domain = domain.replace(/^https:\/\//, '');

if (domain === 'localhost' || domain==="proxy") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;
}

//--------------------------------------------------
// Create the service
const service = new Service('target', domain, token, 1, { 
  finishReporters: [ 
    { 
      type: 'slack', 
      status: 'failure', 
      posturl: config.get('slackposturl'),
    } 
  ]
}); // 1 concurrent job

//--------------------------------------------------
// Set the job type handlers
service.on('transcription', config.get('timeout'),    pdf.jobHandler);
service.on(          'asn', config.get('asntimeout'), asn.jobHandler);

//--------------------------------------------------
// Start the jobs watching service
service.start().catch(e => 
  console.error('Service threw uncaught error: ',e)
);

// Start the things watching to create jobs
pdf.startJobCreator({domain, token});
asn.startJobCreator({domain, token});

