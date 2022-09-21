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

import config from '../dist/config.js';

import test from 'ava';

import { setTimeout } from 'isomorphic-timers-promises';

import debug from 'debug';
import moment from 'moment';

import { type JsonObject, connect } from '@oada/client';

import {
  cleanup,
  items,
  putAndLinkData,
  putData,
  setConnection,
} from './testdata.js';

const trace = debug('target-helper#test:trace');

const doctypes = ['audit', 'cert', 'coi', 'log'] as const;
const REALISTIC_TIMING = true;

const con = await connect({
  domain: config.get('oada.domain'),
  token: config.get('oada.token')[0]!,
});

test.before(async () => {
  setConnection(con);

  // Clear out any old stuff:
  trace('before: cleanup');
  await cleanup();

  trace('before: putData');
  // Build the tree with all the initial data:
  await putAndLinkData(['tp', 'fac', 'logbuyer', 'coiholder']);
  await putData(['pdf']); // Don't link into job tree since that would trigger target-helper to make a job for it

  // All 4 kinds of jobs: coi, audit, cert, log
  // --------------------------------------------------------
  for await (const doctype of doctypes) {
    trace('before: create job for doctype: ', doctype);
    const jobtype: `${typeof doctype}job` = `${doctype}job`; // Coijob, auditjob, etc...
    const index = items[jobtype]!;
    // Example of a successful normal job: go ahead and put that up, tests will check results later
    await putAndLinkData(jobtype, {
      service: 'target',
      type: 'transcription',
      config: {
        type: 'pdf',
        pdf: { _id: `resources/${items.pdf?.key}` },
      },
    });

    // Wait a bit after posting job since that's what target would do:
    if (REALISTIC_TIMING) await setTimeout(500);

    // Now pretend to be target: do NOT use tree because target wouldn't use it
    await con.post({
      path: `${index.list}/${index.key}/updates`,
      contentType: index._type,
      data: {
        status: 'identifying',
        time: moment().format(),
      },
    });
    if (REALISTIC_TIMING) await setTimeout(50);

    await con.post({
      path: `${index.list}/${index.key}/updates`,
      data: {
        status: 'error',
        information: 'Could not identify document',
        time: moment().format(),
      },
    });
  }

  // Wait a bit for processing
  await setTimeout(2000);
});

// Now the real checks begin.  Did target helper:
// 1: _ref pdf from _meta/vdoc/pdf in coi resource
// 2: _ref coi from _meta/vdoc/cois/<id> for PDF resource
// 3: Put the COI up at /bookmarks/trellisfw/cois/<key>
// 5: Sign the thing
// 6: Monitor the coi looking for signature to show up, when it appears then put "status: success" to the job (and post update)
// 7: oada-jobs should move the job to jobs-success under today's index

for (const doctype of doctypes) {
  test(`#${doctype}`, async (t) => {
    const jobtype: `${typeof doctype}job` = `${doctype}job`;
    const index = items[doctype]!;
    const jobIndex = items[jobtype]!;

    const error1 = await t.throwsAsync(
      con.get({ path: `/resources/${index.key}/_meta/vdoc/pdf` }),
      {},
      `should NOT _ref the PDF at _meta/vdoc/pdf in the ${doctype} resource`
    );
    // @ts-expect-error dumb errors
    t.is(error1?.status, 403);

    const error2 = await t.throwsAsync(
      con.get({
        path: `/resources/${items.pdf?.key}/_meta/vdoc/${index.name.plural}/${index.key}`,
      }),
      {},
      `should NOT _ref the PDF at _meta/vdoc/${index.name.plural}/<id> in the PDF resource`
    );
    // @ts-expect-error dumb errors
    t.is(error2?.status, 404);

    const error3 = await t.throwsAsync(
      con.get({ path: `${index.list}/${index.key}` }),
      {},
      `should NOT put ${doctype} up at ${index.list}/<key>`
    );
    // @ts-expect-error dumb errors
    t.is(error3?.status, 404);

    const error4 = await t.throwsAsync(
      con.get({ path: `/resources/${index.key}/signatures` }),
      {},
      `should NOT have a signature on the ${doctype}`
    );
    // @ts-expect-error dumb errors
    t.is(error4?.status, 403); // Unauthorized on /resources that don't exist

    const { data: result1 } = await con.get({
      path: `resources/${jobIndex.key}/status`,
    });
    t.is(
      result1,
      'failure',
      'should have status of failure on the job when completed'
    );

    const error5 = await t.throwsAsync(
      con.get({ path: `${jobIndex.list}/${jobIndex.key}` }),
      {},
      `should delete the job from jobs`
    );
    // @ts-expect-error dumb errors
    t.is(error5?.status, 404);

    const day = moment().format('YYYY-MM-DD');
    const { data: result2 } = await con.get({
      path: `/bookmarks/services/target/jobs/failure/day-index/${day}/${jobIndex.key}`,
    });
    t.is(
      (result2 as JsonObject)?._id,
      `resources/${jobIndex.key}`,
      `should put the job under today's day-index ${moment().format(
        'YYYY-MM-DD'
      )} within jobs-failure`
    );
  });
}
