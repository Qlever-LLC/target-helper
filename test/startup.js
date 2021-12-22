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

import config from '../config.mjs';

import Promise from 'bluebird';
import moment from 'moment';
import oada from '@oada/client';

// DO NOT include ../ because we are testing externally.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const jobkey = 'TARGETHELPER_ASNTEST_JOB1'; // Replaced in first test with actual job key
const asnkey = 'TARGETHELPER_ASNTEST_ASN1';
const jobID = `resources/${jobkey}`;
const asnID = `resources/${asnkey}`;
const dayIndex = moment().format('YYYY-MM-DD');
const listheaders = { 'content-type': 'application/vnd.trellisfw.asns.1+json' };

let con = false;
describe('External ASN tests of target-helper, run from admin', () => {
  before(async () => {
    con = await oada.connect({
      domain: config.get('domain'),
      token: config.get('token'),
    });
  });

  beforeEach(async () => {
    await cleanup();
  });

  it(`Shouldn't reprocess existing queue items if resume is set to true`, async function () {
    // eslint-disable-next-line no-invalid-this
    this.timeout(5000);

    await con.put({
      path: `/resources/testa1`,
      data: { test: 'hello1' },
      headers: listheaders,
    });
    await con.put({
      path: `/resources/testa2`,
      data: { test: 'hello2' },
      headers: listheaders,
    });
    await con.put({
      path: `/resources/testa3`,
      data: { test: 'hello3' },
      headers: listheaders,
    });
    await con.put({
      path: `/resources/testa4`,
      data: { test: 'hello4' },
      headers: listheaders,
    });

    await con.put({
      path: `/resources/testa5`,
      data: { test: 'hello5' },
      headers: listheaders,
    });
    await con.put({
      path: `/resources/testa6`,
      data: { test: 'hello6' },
      headers: listheaders,
    });

    // Create day 1
    await con.put({
      path: `/resources/test-day1`,
      data: {
        testq1: { _id: `resources/testa1`, _rev: 0 },
        testq2: { _id: `resources/testa2`, _rev: 0 },
        testq3: { _id: `resources/testa3`, _rev: 0 },
        testq4: { _id: `resources/testa4`, _rev: 0 },
      },
      headers: listheaders,
    });

    await con.put({
      path: `/resources/test-day2`,
      data: {
        testq5: { _id: `resources/testa5`, _rev: 0 },
        testq6: { _id: `resources/testa6`, _rev: 0 },
      },
      headers: listheaders,
    });

    // Create the list
    await con.put({
      path: `/resources/test-list1`,
      data: {
        'day-index': {
          '2021-01-01': { _id: `resources/test-day1`, _rev: 0 },
          '2021-01-02': { _id: `resources/test-day2`, _rev: 0 },
        },
      },
      headers: listheaders,
    });
  });
});

async function cleanup() {
  return Promise.all(
    [
      `/bookmarks/trellisfw/asns/${asnkey}`,
      `/${asnID}`,
      `/bookmarks/trellisfw/jobs/${jobkey}`,
      `/bookmarks/trellisfw/jobs-success/day-index/${dayIndex}/${jobkey}`,
      `/bookmarks/trellisfw/jobs-failure/day-index/${dayIndex}/${jobkey}`,
      `/${jobID}`,
    ].map((path) => deleteIfExists(path))
  );
}

async function deleteIfExists(path) {
  try {
    await con.get({ path });
    await con.delete({ path }); // Delete it
  } catch {
    // Do nothing, didn't exist
  }
}
