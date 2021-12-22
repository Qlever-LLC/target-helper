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

import readline from 'node:readline'; // Node.js built-in

import debug from 'debug';
import ksuid from 'ksuid';
import minimist from 'minimist';
import moment from 'moment';
import oada from '@oada/client';

const trace = debug('target-helper#test:trace');
const argv = minimist(process.argv.slice(2));

// DO NOT include ../ because we are testing externally.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const jobkey = 'TARGETHELPER_ASNTEST_JOB1'; // Replaced in first test with actual job key
const asnkey = 'TARGETHELPER_ASNTEST_ASN1';
const jobid = `resources/${jobkey}`;
const asnid = `resources/${asnkey}`;
const dayIndex = moment().format('YYYY-MM-DD');
const headers = { 'content-type': 'application/vnd.trellisfw.asn.sf.1+json' };
const listheaders = { 'content-type': 'application/vnd.trellisfw.asns.1+json' };
const jobsheaders = { 'content-type': 'application/vnd.oada.job.1+json' };

if (!argv.force) {
  console.log(
    'ERROR: you must pass --force because this WILL REPLACE THE BOOKMARKS/TRELLISFW/ASNS LINK WITH A BLANK TEST ONE.  It SHOULD restore that one when you hit enter after the script pauses.'
  );
  process.exit(1);
}

console.log('Replacing /bookmarks/trellisfw/asns with a new blank test tree');

const con = await oada.connect({
  domain: config.get('domain'),
  token: config.get('token'),
});

const { data: oldID } = await con.get({
  path: `/bookmarks/trellisfw/asns/_id`,
});
console.log('The original ASN ID (KEEP THIS JUST IN CASE!) was:', oldID);

const { string: listID } = await ksuid.random();
const data = {
  '2021-01-15': {
    id: ksuid.randomSync().string,
    asnids: [
      ksuid.randomSync().string,
      ksuid.randomSync().string,
      ksuid.randomSync().string,
      ksuid.randomSync().string,
    ],
  },
  '2021-01-16': {
    id: ksuid.randomSync().string,
    asnids: [ksuid.randomSync().string, ksuid.randomSync().string],
  },
};

let count = 0;
for await (const [day, d] of Object.entries(data)) {
  console.log('Creating', day);
  for await (const a of d.asnids) {
    console.log(`      Creating ${day}/${a}`);
    await con.put({
      path: `/resources/${a}`,
      data: { test: `hello${count++}` },
      headers,
    });
  }

  console.log(`        Creating resource for ${day}`);
  await con.put({
    path: `/resources/${d.id}`,
    data: d.asnids.reduce((accumulator, a, ai) => {
      accumulator[`test${ai}`] = { _id: `resources/${a}`, _rev: 0 };
      return accumulator;
    }, {}),
    headers: listheaders,
  });
}

// Create the list
console.log('Creating top asns list at resources/', listID);
await con.put({
  path: `/resources/${listID}`,
  data: {
    'day-index': Object.keys(data).reduce((accumulator, day) => {
      accumulator[day] = { _id: `resources/${data[day].id}`, _rev: 0 };
      return accumulator;
    }, {}),
  },
  headers: listheaders,
});

console.log('Linking new asns list under bookmarks/trellisfw', listID);
await con.put({
  path: `/bookmarks/trellisfw`,
  data: { asns: { _id: `resources/${listID}` } },
  headers: { 'content-type': 'application/vnd.trellisfw.1+json' },
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// ---------------------------------------------------
// Wait until ready, then keeping post new ASNs and waiting until they say stop:
const newASNDay = Object.keys(data)[0];
const newasnids = [];
let response = '';
do {
  const newASNid = ksuid.randomSync().string;
  newasnids.push(newASNid);
  // eslint-disable-next-line no-await-in-loop
  response = await new Promise((resolve, reject) => {
    rl.question(
      `When you press enter, I will put a new dummy ASN to /bookmarks/trellisfw/asns/day-index/${newASNDay}/${newASNid}.  To stop, type stop and then hit enter`,
      resolve
    );
  });
  if (response === 'stop') break;
  // eslint-disable-next-line no-await-in-loop
  await con.put({
    path: `/resources/${newASNid}`,
    data: { hello: 'testnewasn' },
    headers,
  });
  // eslint-disable-next-line no-await-in-loop
  await con.put({
    path: `/bookmarks/trellisfw/asns/day-index/${newASNDay}`,
    data: { [newASNid]: { _id: `resources/${newASNid}`, _rev: 0 } },
    listheaders,
  });
  console.log('New asn created at', newASNid, 'and linked under', newASNDay);
} while (response !== 'stop');

// ---------------------------------------------------
// Wait until ready, then reset bookmarks and cleanup resources
await new Promise((resolve, reject) => {
  rl.question(
    `Sitting here until you press enter, then I will put back original /bookmarks/trellisfw/asns from old id.  ${oldID}`,
    resolve
  );
});
console.log('Putting back original bookmarks/trellisfw/asns from id', oldID);
await con.put({
  path: `/bookmarks/trellisfw`,
  data: { asns: { _id: oldID } },
  headers: { 'content-type': 'application/vnd.trellisfw.1+json' },
});
console.log('Deleting all those resources to cleanup');

const ids = [
  ...newasnids,
  listID,
  ...Object.keys(data).reduce((accumulator, day) => {
    accumulator.push(data[day].id);
    return [...accumulator, ...data[day].asnids];
  }, []),
];
console.log('    Deleting ids:', ids);
for await (const index of ids) {
  con.delete({ path: `/resources/${index}` });
}

console.log(
  '\n\nDO NOT FORGET TO RESTART TARGET-HELPER SO IT PICKS THE OLD BOOKMARKS WATCH UP AGAIn\n\n'
);
process.exit(0);

async function deleteIfExists(path) {
  try {
    await con.get({ path });
    await con.delete({ path }); // Delete it
  } catch {
    // Do nothing, didn't exist
  }
}
