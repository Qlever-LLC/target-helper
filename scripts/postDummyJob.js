/**
 * @license
 * Copyright 2021 Qlever LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* eslint-disable no-console */
/* eslint-disable no-process-exit */
/* eslint-disable unicorn/no-process-exit */

import config from '../config.js';

import oada from '@oada/client';

const jobpath = `/bookmarks/services/target/jobs`;
const pdfkey = 'TEST-PDF1';
const auditkey = 'TEST-FSQAAUDIT1-DUMMY';

const tree = {
  bookmarks: {
    _type: 'application/vnd.oada.bookmarks.1+json',
    services: {
      _type: 'application/vnd.oada.services.1+json',
      target: {
        '_type': 'application/vnd.oada.service.1+json',
        'jobs': {
          '_type': 'application/vnd.oada.jobs.1+json',
          '*': {
            _type: 'application/vnd.oada.job.1+json',
          },
        },
        'jobs-success': {
          '_type': 'application/vnd.oada.jobs.1+json',
          '*': {
            _type: 'application/vnd.oada.job.1+json',
          },
        },
        'jobs-error': {
          '_type': 'application/vnd.oada.jobs.1+json',
          '*': {
            _type: 'application/vnd.oada.job.1+json',
          },
        },
      },
    },
  },
};

process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;
let domain = config.get('domain');
if (domain.startsWith('http')) domain = domain.replace(/^https:\/\//, '');
const con = await oada.connect({ domain, token: config.get('token') });
try {
  await con.get({ path: `/resources/${pdfkey}` });
} catch (error) {
  if (error && error.status === 404) {
    console.log('resources/TEST-PDF1 does not exist, creating a dummy one');
    await con.put({
      path: `/resources/${pdfkey}`,
      data: {},
      headers: { 'content-type': 'application/pdf' },
    });
  }
}

// --------------------------------------------------------
// Example of a successful normal job: go ahead and put that up, tests will check results later
const {
  data: {
    headers: { 'content-location': location },
  },
} = await con.post({
  path: `/resources`,
  headers: { 'content-type': 'application/vnd.oada.job.1+json' },
  data: {
    type: 'pdf',
    config: {
      pdf: { _id: `resources/${pdfkey}` },
    },
  },
});
const jobkey = location?.replace(/^\/resources\//, '');

// Link job under queue to start things off:
console.log('Creating job key:', jobkey);
await con.put({
  path: `${jobpath}`,
  headers: { 'content-type': 'application/vnd.oada.jobs.1+json' },
  data: {
    [jobkey]: { _id: `resources/${jobkey}` },
  },
});

process.exit(0);
