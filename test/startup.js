const _ = require('lodash')
const expect = require('chai').expect
const Promise = require('bluebird')
const debug = require('debug')
const moment = require('moment');

const trace = debug('target-helper#test:trace');

// DO NOT include ../ because we are testing externally.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const oada = require('@oada/client');

let jobkey = 'TARGETHELPER_ASNTEST_JOB1'; // replaced in first test with actual job key
const asnkey = 'TARGETHELPER_ASNTEST_ASN1';
const jobid = `resources/${jobkey}`;
const asnid = `resources/${asnkey}`;
const dayIndex = moment().format('YYYY-MM-DD');
const testasn = require('./testasn');
const headers = { 'content-type': 'application/vnd.trellisfw.asn.sf.1+json' };
const listheaders = { 'content-type': 'application/vnd.trellisfw.asns.1+json' };
const jobsheaders = { 'content-type': 'application/vnd.oada.job.1+json' };

let con = false;
describe('External ASN tests of target-helper, run from admin', () => {

    before(async () => {
      con = await oada.connect({ domain: 'proxy', token: 'god-proxy' });
    })

    beforeEach(async () => {
      await cleanup()
    });

    after(async () => await cleanup());

    it(`Shouldn't reprocess existing queue items if resume is set to true`, async function() {
      this.timeout(5000);

      await con.put({ path: `/resources/testq1`, data: { test: "hello1" }, headers: listheaders });
      await con.put({ path: `/resources/testq2`, data: { test: "hello2" }, headers: listheaders });
      await con.put({ path: `/resources/testq3`, data: { test: "hello3" }, headers: listheaders });
      await con.put({ path: `/resources/testq4`, data: { test: "hello4" }, headers: listheaders });

      await con.put({ path: `/resources/testq5`, data: { test: "hello5" }, headers: listheaders });
      await con.put({ path: `/resources/testq6`, data: { test: "hello6" }, headers: listheaders });

      //create day 1
      await con.put({ 
        path: `/resources/test-day-1`, 
        data: {
          testq1: {_id: `resources/testq1`, "_rev": 0},
          testq2: {_id: `resources/testq2`, "_rev": 0},
          testq3: {_id: `resources/testq3`, "_rev": 0},
          testq4: {_id: `resources/testq4`, "_rev": 0},
        },
        headers: listheaders
      })

      await con.put({ 
        path: `/resources/test-day-2`, 
        data: {
          testq5: {_id: `resources/testq5`, "_rev": 0},
          testq6: {_id: `resources/testq6`, "_rev": 0},
        },
        headers: listheaders
      })

      //create the list
      await con.put({ 
        path: `/resources/test-list-1`, 
        data: {
          "day-index": {
            "2021-01-01": {_id: `resources/test-day-1`, "_rev": 0 },
            "2021-01-02": {_id: `resources/test-day-2`, "_rev": 0 },
          }
        },
        headers: listheaders
      })
    });
})

async function cleanup() {

  return Promise.map([
    `/bookmarks/trellisfw/asns/${asnkey}`,
    `/${asnid}`,
    `/bookmarks/trellisfw/jobs/${jobkey}`,
    `/bookmarks/trellisfw/jobs-success/day-index/${dayIndex}/${jobkey}`,
    `/bookmarks/trellisfw/jobs-failure/day-index/${dayIndex}/${jobkey}`,
    `/${jobid}`,
  ], deleteIfExists);

}

async function deleteIfExists(path) {
  await con.get({ path })
  .then(async () => con.delete({ path })) // delete it
  .catch(e => {} ) // do nothing, didn't exist
}
