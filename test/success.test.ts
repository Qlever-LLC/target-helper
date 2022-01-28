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

import config from '../src/config.js';

import { setTimeout } from 'isomorphic-timers-promises';

import test from 'ava';

import _ from 'lodash';
import debug from 'debug';
import moment from 'moment';
import oada from '@oada/client';

import {
  cleanup,
  items,
  putAndLinkData,
  putData,
  putLink,
  setConnection,
} from './testdata.js';

const trace = debug('target-helper#test:trace');

const REALISTIC_TIMING = true;

const doctypes = ['audit', 'cert', 'coi', 'log'];

const con = await oada.connect({
  domain: config.get('oada.domain'),
  token: config.get('oada.token')[0]!,
});

test.before(async (t) => {
  t.timeout(20_000);
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
    const jobtype = `${doctype}job`; // Coijob, auditjob, etc...
    const index = items[jobtype];
    // Example of a successful normal job: go ahead and put that up, tests will check results later
    await putAndLinkData(jobtype, {
      service: 'target',
      type: 'transcription',
      config: {
        type: 'pdf',
        pdf: { _id: `resources/${items.pdf.key}` },
      },
    });

    // Wait a bit after posting job since that's what target would do:
    if (REALISTIC_TIMING) await setTimeout(500);

    // Now pretend to be target: do NOT use tree because target wouldn't use it
    await con.post({
      path: `${index.list}/${index.key}/updates`,
      _type: index._type,
      data: {
        status: 'identifying',
        time: moment().format(),
      },
    });
    if (REALISTIC_TIMING) await setTimeout(50);
    await con.post({
      path: `${index.list}/${index.key}/updates`,
      _type: index._type,
      data: {
        status: 'identified',
        information: `Identified as ${doctype}`,
        time: moment().format(),
      },
    });
    if (REALISTIC_TIMING) await setTimeout(50);

    // Create the JSON resource
    const index_ = items[doctype];
    await putData(doctype);

    // Add the identified "lookup" to it's meta:
    let meta;
    switch (doctype) {
      case 'audit':
        meta = { organization: { _ref: `resources/${items.fac.key}` } };
        break;
      case 'cert':
        meta = { organization: { _ref: `resources/${items.fac.key}` } };
        break;
      case 'coi':
        meta = { holder: { _ref: `resources/${items.coiholder.key}` } };
        break;
      case 'log':
        meta = { buyer: { _ref: `resources/${items.logbuyer.key}` } };
        break;
      default:
        throw new Error(`Unknown doctype: ${doctype}`);
    }

    await con.put({
      path: `/resources/${index_.key}/_meta/lookups/${index_.name.singular}`,
      data: meta,
    });

    // Link the final resource into the main list for this doctype:
    await putLink(doctype);

    // Put back result to the job
    await con.put({
      path: `${index.list}/${index.key}/result`,
      data: {
        [index_.name.plural]: {
          [index_.key]: { _id: `resources/${index_.key}` },
        },
      },
    });

    // Post success update back to the job, which should kick off the rest of target-helper
    await con.post({
      path: `${index.list}/${index.key}/updates`,
      data: {
        status: 'success',
        type: index_.name.singular,
        time: moment().format(),
      },
    });
  }

  // Wait a bit for processing all the jobs
  if (REALISTIC_TIMING) {
    await setTimeout(2000);
  }
});

// Now the real checks begin.  Did target helper:
// 1: _ref pdf from _meta/vdoc/pdf in coi resource
// 2: _ref coi from _meta/vdoc/cois/<id> for PDF resource
// 3: Put the COI up at /bookmarks/trellisfw/cois/<key>
// 5: Sign the thing
// 6: Monitor the coi looking for signature to show up, when it appears then put "status: success" to the job (and post update)
// 7: oada-jobs should move the job to jobs-success under today's index

_.each(doctypes, (doctype) => {
  describe(`#${doctype}`, () => {
    const jobtype = `${doctype}job`;
    const index = items[doctype];
    const index_ = items[jobtype];

    it(`should _ref the ${jobtype} under pdf/_meta/services/target/jobs`, async () => {
      const path = `/resources/${items.pdf.key}/_meta/services/target/jobs/${index_.key}`;
      const { data: result } = await con.get({ path });
      expect(result._ref).to.equal(`resources/${index_.key}`);
    });

    it(`should link to the PDF at _meta/vdoc/pdf in the ${doctype} resource`, async () => {
      const { data: result } = await con.get({
        path: `/resources/${index.key}/_meta/vdoc`,
      });
      expect(result).to.deep.equal({
        pdf: { _id: `resources/${items.pdf.key}` },
      });
    });

    it(`should _ref the ${doctype} from _meta/vdoc/${index.name.plural}/<id> in PDF resource`, async () => {
      const { data: result } = await con.get({
        path: `/resources/${items.pdf.key}/_meta/vdoc/${index.name.plural}/${index.key}`,
      });
      expect(result).to.deep.equal({ _ref: `resources/${index.key}` });
    });

    it(`should put ${doctype} up at ${index.list}/<key>`, async () => {
      const { data: result } = await con.get({
        path: `${index.list}/${index.key}`,
      });
      expect(result._id).to.equal(`resources/${index.key}`); // It exists
    });

    it(`should have a signature on the ${doctype}`, async () => {
      const { data: result } = await con.get({
        path: `/resources/${index.key}/signatures`,
      });
      expect(result).to.be.an('array');
      expect(result.length).to.equal(1);
    });

    it(`should have status of success on the ${jobtype} when completed`, async () => {
      const { data: result } = await con.get({
        path: `/resources/${index_.key}/status`,
      });
      expect(result).to.equal('success');
    });

    it(`should delete the ${jobtype} from ${index_.list}`, async () => {
      const result = await con
        .get({ path: `${index_.list}/${index_.key}` })
        .catch((error_) => error_); // Returns the error
      expect(result.status).to.equal(404);
    });

    it(`should put the ${jobtype} under today's day-index ${moment().format(
      'YYYY-MM-DD'
    )} within jobs-success`, async () => {
      const day = moment().format('YYYY-MM-DD');
      const { data: result } = await con.get({
        path: `/bookmarks/services/target/jobs-success/day-index/${day}/${index_.key}`,
      });
      expect(result._id).to.equal(`resources/${index_.key}`);
    });
  });
});
