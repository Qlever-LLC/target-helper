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

import { connect } from "@oada/client";

import test from "ava";
import moment from "moment";
import config from "../dist/config.js";

// DO NOT include ../ because we are testing externally.

// External ASN tests of target-helper, run from admin

const jobkey = "TARGETHELPER_ASNTEST_JOB1"; // Replaced in first test with actual job key
const asnkey = "TARGETHELPER_ASNTEST_ASN1";
const jobID = `resources/${jobkey}`;
const asnID = `resources/${asnkey}`;
const dayIndex = moment().format("YYYY-MM-DD");
const contentType = "application/vnd.trellisfw.asns.1+json";

const con = await connect({
  domain: config.get("oada.domain"),
  token: config.get("oada.token")[0],
});

test.beforeEach(async () => {
  await cleanup();
});

test.failing(
  "Should not reprocess existing queue items if resume is set to true",
  async () => {
    await con.put({
      path: "/resources/testa1",
      data: { test: "hello1" },
      contentType,
    });
    await con.put({
      path: "/resources/testa2",
      data: { test: "hello2" },
      contentType,
    });
    await con.put({
      path: "/resources/testa3",
      data: { test: "hello3" },
      contentType,
    });
    await con.put({
      path: "/resources/testa4",
      data: { test: "hello4" },
      contentType,
    });

    await con.put({
      path: "/resources/testa5",
      data: { test: "hello5" },
      contentType,
    });
    await con.put({
      path: "/resources/testa6",
      data: { test: "hello6" },
      contentType,
    });

    // Create day 1
    await con.put({
      path: "/resources/test-day1",
      data: {
        testq1: { _id: "resources/testa1", _rev: 0 },
        testq2: { _id: "resources/testa2", _rev: 0 },
        testq3: { _id: "resources/testa3", _rev: 0 },
        testq4: { _id: "resources/testa4", _rev: 0 },
      },
      contentType,
    });

    await con.put({
      path: "/resources/test-day2",
      data: {
        testq5: { _id: "resources/testa5", _rev: 0 },
        testq6: { _id: "resources/testa6", _rev: 0 },
      },
      contentType,
    });

    // Create the list
    await con.put({
      path: "/resources/test-list1",
      data: {
        "day-index": {
          "2021-01-01": { _id: "resources/test-day1", _rev: 0 },
          "2021-01-02": { _id: "resources/test-day2", _rev: 0 },
        },
      },
      contentType,
    });
  },
);

async function cleanup() {
  return Promise.all(
    [
      `/bookmarks/trellisfw/asns/${asnkey}`,
      `/${asnID}`,
      `/bookmarks/services/target/jobs/pending/${jobkey}`,
      `/bookmarks/trellisfw/jobs/${jobkey}`,
      `/bookmarks/services/target/jobs/success/day-index/${dayIndex}/${jobkey}`,
      `/bookmarks/services/target/jobs/failure/day-index/${dayIndex}/${jobkey}`,
      `/${jobID}`,
    ].map(async (path) => deleteIfExists(path)),
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
