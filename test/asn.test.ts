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

import config from "../dist/config.js";

import test from "ava";

import { setTimeout } from "isomorphic-timers-promises";

import { difference } from "lodash-es";
import moment from "moment";

import { connect } from "@oada/client";

import type Job from "@oada/types/oada/service/job.js";

import testAsn from "./testAsn.js";

// DO NOT include ../ because we are testing externally.

let jobkey = "TARGETHELPER_ASNTEST_JOB1"; // Replaced in first test with actual job key
const asnkey = "TARGETHELPER_ASNTEST_ASN1";
const jobID = `resources/${jobkey}`;
const asnID = `resources/${asnkey}`;
const dayIndex = moment().format("YYYY-MM-DD");
const contentType = "application/vnd.trellisfw.asn.sf.1+json";
const pending = "/bookmarks/services/target/jobs/pending";

const con = await connect({
  domain: config.get("oada.domain"),
  token: config.get("oada.token")[0],
});

test.after(async () => {
  await cleanup();
});

test.beforeEach(async () => {
  await cleanup();
});

test("Should create a job to handle the test ASN when posted to /bookmarks/trellisfw/asns", async (t) => {
  // Get the initial job queue so we can figure out which job was created as a result of our posted test doc
  const { data: oldJobs } = await con.get({
    path: pending,
  });

  // Post the test doc
  await con.put({ path: `/${asnID}`, data: testAsn, contentType });
  await con.put({
    path: `/bookmarks/trellisfw/asns/${asnkey}`,
    data: { _id: asnID, _rev: 0 },
    contentType: "application/vnd.trellisfw.asns.1+json",
  });
  await setTimeout(500); // Give it a second to make the job

  // get the new job list, find the new key
  const { data: newJobs } = await con.get({
    path: pending,
  });
  jobkey = difference(
    Object.keys(newJobs ?? {}),
    Object.keys(oldJobs ?? {}),
  )[0]!; // Assume first difference is new one
  t.is(jobkey, "string");
  t.assert(jobkey.length > 0);
  if (!jobkey || jobkey.length === 0) {
    throw new Error("TEST ERROR: job never showed up for ASN");
  }

  // Get the job info, validate it
  const { data: job } = (await con.get({
    path: `${pending}/${jobkey}`,
  })) as unknown as { data: Job };
  t.is(job?.type, "asn");
  t.is(job?.config?.type, "asn");
  t.deepEqual(job?.config?.asn, { _id: asnID });

  // Mark the job as "success"
  await con.post({
    path: `${pending}/${jobkey}/updates`,
    data: { status: "success", info: "test was a success" },
    contentType: "application/vnd.oada.job.1+json",
  });
  await setTimeout(1500); // Wait for oada-jobs to move it to jobs-success
  try {
    const { data: doesnotexist } = await con.get({
      path: `${pending}/${jobkey}`,
    });
    t.true(doesnotexist);
  } catch (error: unknown) {
    // @ts-expect-error stupid errors
    t.is(error?.status, 404);
  }
});

test("Should error on an ASN job which posts an invalid update (i.e. update is a string)", async (t) => {
  // Get the initial job queue so we can figure out which job was created as a result of our posted test doc
  const { data: oldJobs } = await con.get({
    path: `${pending}`,
  });

  // Post the test doc
  await con.put({ path: `/${asnID}`, data: testAsn, contentType });
  await con.put({
    path: `/bookmarks/trellisfw/asns/${asnkey}`,
    data: { _id: asnID, _rev: 0 },
    contentType: "application/vnd.trellisfw.asns.1+json",
  });
  await setTimeout(500); // Give it a second to make the job
  const day = moment().format("YYYY-MM-DD"); // Keep this for the day-index below

  // get the new job list, find the new key
  const { data: newJobs } = await con.get({
    path: `${pending}`,
  });
  jobkey = difference(
    Object.keys(newJobs ?? {}),
    Object.keys(oldJobs ?? {}),
  )[0]!; // Assume first difference is new one
  t.is(typeof jobkey, "string");
  t.assert(jobkey.length > 0);
  if (!jobkey || jobkey.length === 0) {
    throw new Error("TEST ERROR: job never showed up for ASN");
  }

  // Get the job info, validate it
  const { data: job } = (await con.get({
    path: `${pending}/${jobkey}`,
  })) as unknown as { data: Job };
  t.is(job?.type, "asn");
  t.is(job?.config?.type, "asn");
  t.deepEqual(job?.config?.asn, { _id: asnID });

  // Put the "bad" status update
  await con.put({
    path: `${pending}/${jobkey}/updates`,
    data: { status: "error_bad_update" },
    contentType: "application/vnd.oada.job.1+json",
  });
  await setTimeout(1500); // Wait for oada-jobs to move it to jobs-error
  const doesnotexist = await con
    .get({ path: `${pending}/${jobkey}` })
    .then((r) => r.data)
    .catch((error) => error.status === 404);
  const errorexists = await con
    .get({
      path: `/bookmarks/services/target/jobs/failure/day-index/${day}/${jobkey}`,
    })
    .then((r) => Boolean(r.data))
    .catch(() => false);
  t.true(doesnotexist);
  t.true(errorexists);
});

async function cleanup() {
  return Promise.all(
    [
      `/bookmarks/trellisfw/asns/${asnkey}`,
      `/${asnID}`,
      `/bookmarks/services/target/jobs/pending/${jobkey}`,
      `/bookmarks/services/target/jobs/success/day-index/${dayIndex}/${jobkey}`,
      `/bookmarks/services/target/jobs/failure/day-index/${dayIndex}/${jobkey}`,
      `/${jobID}`,
    ].map(async (value) => deleteIfExists(value)),
  );
}

async function deleteIfExists(path: string) {
  try {
    await con.get({ path });
    await con.delete({ path }); // Delete it
  } catch {
    // Do nothing, didn't exist
  }
}
