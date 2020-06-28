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

    it('Should create a job to handle the test ASN when posted to /bookmarks/trellisfw/asns', async function() {
      this.timeout(5000);

      // get the initial job queue so we can figure out which job was created as a result of our posted test doc
      const oldJobs = await con.get({ path: `/bookmarks/services/target/jobs` }).then(r=>r.data);

      // post the test doc
      await con.put({ path: `/${asnid}`, data: testasn, headers});
      await con.put({ path: `/bookmarks/trellisfw/asns/${asnkey}`, data: { _id: asnid, _rev: 0 }, headers: listheaders });
      await Promise.delay(500); // give it a second to make the job

      // get the new job list, find the new key
      const newJobs = await con.get({ path: `/bookmarks/services/target/jobs` }).then(r=>r.data);
      jobkey = _.difference(_.keys(newJobs), _.keys(oldJobs))[0]; // assume first difference is new one
      expect(jobkey).to.be.a('string');
      expect(jobkey).to.have.length.above(0);
      if (!jobkey || jobkey.length < 1) {
        throw new Error('TEST ERROR: job never showed up for ASN');
      }

      // get the job info, validate it
      const job = await con.get({ path: `/bookmarks/services/target/jobs/${jobkey}` }).then(r=>r.data);
      expect(job.type).to.equal('asn');
      expect(job.config.type).to.equal('asn');
      expect(job.config.asn).to.deep.equal({ _id: asnid });

      // Mark the job as "success"
      await con.post({ path: `/bookmarks/services/target/jobs/${jobkey}/updates`, data: { "status": "success", "info": "test was a success" }, headers: jobsheaders });
      await Promise.delay(1500); // wait for oada-jobs to move it to jobs-success
      const doesnotexist = await con.get({ path: `/bookmarks/services/target/jobs/${jobkey}`}).then(r=>r.data).catch(e => (e.status === 404));
      expect(doesnotexist).to.equal(true);
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
