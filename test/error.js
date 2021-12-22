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

import { setTimeout } from 'node:timers/promises';

import _ from 'lodash';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import debug from 'debug';
import moment from 'moment';
import oada from '@oada/client';

import {
  cleanup,
  items,
  putAndLinkData,
  putData,
  setConnection,
} from './testdata.js';

const trace = debug('target-helper#test:trace');

chai.use(chaiAsPromised);
const { expect } = chai;

const domain = 'proxy';
const token = 'god-proxy';

const doctypes = ['audit', 'cert', 'coi', 'log'];
const REALISTIC_TIMING = true;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;
describe('error job', () => {
  let con = false;

  before(async function () {
    // eslint-disable-next-line no-invalid-this
    this.timeout(20_000);
    con = await oada.connect({ domain, token });
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

  _.each(doctypes, (doctype) => {
    describe(`#${doctype}`, () => {
      const jobtype = `${doctype}job`;
      const index = items[doctype];
      const index_ = items[jobtype];

      it(`should NOT _ref the PDF at _meta/vdoc/pdf in the ${doctype} resource`, async () => {
        const result = await con
          .get({ path: `/resources/${index.key}/_meta/vdoc/pdf` })
          .catch((error_) => error_.status);
        expect(result).to.equal(403); // Unauthorized on /resources that don't exist
      });

      it(`should NOT _ref the ${doctype} from _meta/vdoc/${index.name.plural}/<id> in PDF resource`, async () => {
        const result = await con
          .get({
            path: `/resources/${items.pdf.key}/_meta/vdoc/${index.name.plural}/${index.key}`,
          })
          .catch((error_) => error_.status);
        expect(result).to.equal(404);
      });

      it(`should NOT put ${doctype}  up at ${index.list}/<key>`, async () => {
        const result = await con
          .get({ path: `${index.list}/${index.key}` })
          .catch((error_) => error_.status);
        expect(result).to.equal(404);
      });

      it(`should NOT have a signature on the ${doctype}`, async () => {
        const result = await con
          .get({ path: `/resources/${index.key}/signatures` })
          .catch((error_) => error_.status);
        expect(result).to.equal(403); // Unauthorized on /resources that don't exist
      });

      it('should have status of failure on the job when completed', async () => {
        const { data: result } = await con.get({
          path: `resources/${index_.key}/status`,
        });
        expect(result).to.equal('failure');
      });

      it('should delete the job from jobs', async () => {
        const result = await con
          .get({ path: `${index_.list}/${index_.key}` })
          .catch((error_) => error_); // Returns the error
        expect(result.status).to.equal(404);
      });

      it(`should put the job under today's day-index ${moment().format(
        'YYYY-MM-DD'
      )} within jobs-failure`, async () => {
        const day = moment().format('YYYY-MM-DD');
        const { data: result } = await con.get({
          path: `/bookmarks/services/target/jobs-failure/day-index/${day}/${index_.key}`,
        });
        expect(result._id).to.equal(`resources/${index_.key}`);
      });
    });
  });
});
