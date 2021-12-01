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

import Promise from 'bluebird';
import _ from 'lodash';
import debug from 'debug';
import { expect } from 'chai';
import moment from 'moment';

import oada from '@oada/client';

import testasn from './testasn.js';

// DO NOT include ../ because we are testing externally.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const trace = debug('target-helper#test:trace');

let jobkey = 'TARGETHELPER_ASNTEST_JOB1'; // Replaced in first test with actual job key
const asnkey = 'TARGETHELPER_ASNTEST_ASN1';
const jobID = `resources/${jobkey}`;
const asnID = `resources/${asnkey}`;
const dayIndex = moment().format('YYYY-MM-DD');
const headers = { 'content-type': 'application/vnd.trellisfw.asn.sf.1+json' };

let con;
describe('External ASN tests of target-helper, run from admin', () => {
  before(async () => {
    con = await oada.connect({ domain: 'proxy', token: 'god-proxy' });
  });

  beforeEach(async () => {
    await cleanup();
  });

  after(async () => await cleanup());

  it('Should create a job to handle the test ASN when posted to /bookmarks/trellisfw/asns', async function () {
    this.timeout(5000);

    // Get the initial job queue so we can figure out which job was created as a result of our posted test doc
    const oldJobs = await con
      .get({ path: `/bookmarks/services/target/jobs` })
      .then((r) => r.data);

    // Post the test doc
    await con.put({ path: `/${asnID}`, data: testasn, headers });
    await con.put({
      path: `/bookmarks/trellisfw/asns/${asnkey}`,
      data: { _id: asnID, _rev: 0 },
      contentType: 'application/vnd.trellisfw.asns.1+json',
    });
    await Promise.delay(500); // Give it a second to make the job

    // get the new job list, find the new key
    const newJobs = await con
      .get({ path: `/bookmarks/services/target/jobs` })
      .then((r) => r.data);
    jobkey = _.difference(_.keys(newJobs), _.keys(oldJobs))[0]; // Assume first difference is new one
    expect(jobkey).to.be.a('string');
    expect(jobkey).to.have.length.above(0);
    if (!jobkey || jobkey.length === 0) {
      throw new Error('TEST ERROR: job never showed up for ASN');
    }

    // Get the job info, validate it
    const { data: job } = await con.get({
      path: `/bookmarks/services/target/jobs/${jobkey}`,
    });
    expect(job.type).to.equal('asn');
    expect(job.config.type).to.equal('asn');
    expect(job.config.asn).to.deep.equal({ _id: asnID });

    // Mark the job as "success"
    await con.post({
      path: `/bookmarks/services/target/jobs/${jobkey}/updates`,
      data: { status: 'success', info: 'test was a success' },
      contentType: 'application/vnd.oada.job.1+json',
    });
    await Promise.delay(1500); // Wait for oada-jobs to move it to jobs-success
    const doesnotexist = await con
      .get({ path: `/bookmarks/services/target/jobs/${jobkey}` })
      .then((r) => r.data)
      .catch((error) => error.status === 404);
    expect(doesnotexist).to.equal(true);
  });

  it('Should error on an ASN job which posts an invalid update (i.e. update is a string)', async function () {
    this.timeout(5000);

    // Get the initial job queue so we can figure out which job was created as a result of our posted test doc
    const { data: oldJobs } = await con.get({
      path: `/bookmarks/services/target/jobs`,
    });

    // Post the test doc
    await con.put({ path: `/${asnID}`, data: testasn, headers });
    await con.put({
      path: `/bookmarks/trellisfw/asns/${asnkey}`,
      data: { _id: asnID, _rev: 0 },
      contentType: 'application/vnd.trellisfw.asns.1+json',
    });
    await Promise.delay(500); // Give it a second to make the job
    const day = moment().format('YYYY-MM-DD'); // Keep this for the day-index below

    // get the new job list, find the new key
    const { data: newJobs } = await con.get({
      path: `/bookmarks/services/target/jobs`,
    });
    jobkey = _.difference(_.keys(newJobs), _.keys(oldJobs))[0]; // Assume first difference is new one
    expect(jobkey).to.be.a('string');
    expect(jobkey).to.have.length.above(0);
    if (!jobkey || jobkey.length === 0) {
      throw new Error('TEST ERROR: job never showed up for ASN');
    }

    // Get the job info, validate it
    const { data: job } = await con.get({
      path: `/bookmarks/services/target/jobs/${jobkey}`,
    });
    expect(job.type).to.equal('asn');
    expect(job.config.type).to.equal('asn');
    expect(job.config.asn).to.deep.equal({ _id: asnID });

    // Put the "bad" status update
    await con.put({
      path: `/bookmarks/services/target/jobs/${jobkey}/updates`,
      data: { status: 'error_bad_update' },
      contentType: 'application/vnd.oada.job.1+json',
    });
    await Promise.delay(1500); // Wait for oada-jobs to move it to jobs-error
    const doesnotexist = await con
      .get({ path: `/bookmarks/services/target/jobs/${jobkey}` })
      .then((r) => r.data)
      .catch((error) => error.status === 404);
    const errorexists = await con
      .get({
        path: `/bookmarks/services/target/jobs-failure/day-index/${day}/${jobkey}`,
      })
      .then((r) => Boolean(r.data))
      .catch((error) => false);
    expect(doesnotexist).to.equal(true);
    expect(errorexists).to.equal(true);
  });
});

async function cleanup() {
  return Promise.map(
    [
      `/bookmarks/trellisfw/asns/${asnkey}`,
      `/${asnID}`,
      `/bookmarks/trellisfw/jobs/${jobkey}`,
      `/bookmarks/trellisfw/jobs-success/day-index/${dayIndex}/${jobkey}`,
      `/bookmarks/trellisfw/jobs-failure/day-index/${dayIndex}/${jobkey}`,
      `/${jobID}`,
    ],
    deleteIfExists
  );
}

async function deleteIfExists(path) {
  await con
    .get({ path })
    .then(async () => con.delete({ path })) // Delete it
    .catch((error) => {}); // Do nothing, didn't exist
}
