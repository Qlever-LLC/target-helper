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
import { connect } from '@oada/client';
import readline from 'node:readline';
import minimist from 'minimist';
import chalk from 'chalk';
import Promise from 'bluebird';
import hash from 'object-hash';

(async () => {
  try {
    const argv = minimist(process.argv.slice(2));

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const ask = (message) =>
      new Promise((resolve, reject) => {
        rl.question(chalk.cyan(message), resolve);
      });
    const askYN = async (message) => {
      if (argv.y) {
        console.log(chalk.yellow(message), '- argv.y defaults to yes for all');
        return true;
      }

      const resp = (await ask(`${message} [Yn] `)).toUpperCase();
      if (resp === 'Y' || resp === '') return true;
      return false;
    };

    const yesOrDie = async (message, eulogy) => {
      if (!eulogy) eulogy = 'You did not answer "y", stopping';
      if (await askYN(message)) return true;
      console.log(eulogy);
      process.exit(0);
    };

    const domain = argv.domain || argv.d || 'localhost';
    const token = argv.token || argv.t || 'god';

    const asnhashes = {};
    const asninfo = {};

    await yesOrDie(`About to connect to ${domain}: proceed?`);
    const oada = await connect({ domain, token, connection: 'http' });

    console.log(`Connected: working through asn list to find jobs`);
    const toplist = await oada
      .get({ path: `/bookmarks/trellisfw/asns` })
      .then((r) => r.data);
    const days = Object.keys(toplist['day-index']).filter((k) =>
      k.match(/\d{4}-\d{2}-\d{2}/)
    );
    console.log(`Found these ${days.length} days in main list:`, days);

    const asns = await Promise.each(days, async (day) => {
      if (
        !(await askYN(`  ${day}: Proceed with retrieving ASNs for day ${day}?`))
      ) {
        return; // See if they want to do the next day
      }

      const index = await oada
        .get({ path: `/bookmarks/trellisfw/asns/day-index/${day}` })
        .then((r) => r.data);
      const asnkeys = Object.keys(index).filter((k) => !k.startsWith('_'));
      console.log(`  ${day}: Found ${asnkeys.length}`);

      const monitiskeys = asnkeys.filter((k) => k.match(/^MONITIS/));
      const regularasnkeys = asnkeys.filter((k) => !k.startsWith('MONITIS'));
      if (
        monitiskeys.length > 0 &&
        (await askYN(
          `  ${day}: Of those, ${monitiskeys.length} are monitis.  Delete them?`
        ))
      ) {
        await Promise.each(monitiskeys, async (mk) => {
          console.log(`  ${day}: Deleting link at ${mk}`);
          let path = `/bookmarks/trellisfw/asns/day-index/${day}/${mk}`;
          await oada.delete({ path });
          path = `/${index[mk]._id}`;
          console.log(`  ${day}: Deleting resource at ${path}`);
          await oada.delete({ path });
          await Promise.delay(200); // 5 per second
        });
      }

      await yesOrDie(
        `  ${day}: Have ${regularasnkeys.length} regular ASN keys: retrieve their jobs and hashes to look for success/failure and duplicates?`
      );

      await Promise.each(regularasnkeys, async (key) => {
        const resid = index[key]._id; // Get it out of the link
        const asn = await oada.get({ path: `/${resid}` }).then((r) => r.data); // Get resources path directly avoids graph lookup
        const joblist = await oada
          .get({ path: `/${resid}/_meta/services/target/jobs` })
          .then((r) => r.data);

        // Compute the hash to see if we have any duplicates
        const { _id, _rev, _type, _meta, ...cleanasn } = asn;
        const h = hash(cleanasn);
        if (!asnhashes[h]) {
          asnhashes[h] = [];
        }

        asnhashes[h].push({ key, id: resid, hash: h, day });

        asninfo[resid] = {
          key,
          id: resid,
          jobs: {},
          hash: h,
          looksLegit: Boolean(cleanasn._BEGIN || cleanasn.ZSHPMNT05),
        };
        const info = asninfo[resid];

        // Get all the job _refs
        const jobrefs = Object.keys(joblist).map((index_) => ({
          key: index_,
          id: joblist[index_]._ref,
        }));
        console.log(
          `  ${day}: Retrieving ${jobrefs.length} jobs for asn ${resid}`
        );
        await Promise.each(jobrefs, async (index_) => {
          const job = await oada
            .get({ path: `/${index_.id}` })
            .then((r) => r.data);
          job.ISTIMEOUT = JSON.stringify(job).match(/timeout/i);
          job.ISSUCCESS = job.status === 'success';
          info.jobs[index_.key] = job;
          await Promise.delay(100);
        });
        info.lastjobkey = Object.keys(info.jobs).sort().reverse()[0]; // Ksuids sort lexically
        info.lastjob = info.jobs[info.lastjobkey];

        await Promise.delay(100);
      });
      // Summarize results:
      const duplicates = Object.keys(asnhashes)
        .map((hk) => asnhashes[hk])
        .filter((h) => h.length > 1);
      console.log(
        `  ${day}: Have ${duplicates.length} duplicates:`,
        duplicates
      );

      const multijobs = Object.keys(asninfo)
        .map((ak) => asninfo[ak])
        .filter((a) => Object.keys(a.jobs).length > 1);
      console.log(
        `  ${day}: Have ${multijobs.length} asn's with multiple jobs listed:`,
        multijobs.map((index_) => ({
          key: index_.key,
          id: index_.id,
          looksLegit: index_.looksLegit,
          lastjobid: index_.lastjob?._id,
          lastjobIsSuccess: index_.lastjob?.ISSUCCESS,
          lastjobIsTimeout: index_.lastjob?.ISTIMEOUT,
          numberJobs: Object.keys(index_.jobs).length,
          numberSuccessJobs: Object.keys(index_.jobs)
            .map((jk) => index_.jobs[jk])
            .filter((job) => job.ISSUCCESS).length,
        }))
      );

      const timeouts = Object.keys(asninfo)
        .map((ak) => asninfo[ak])
        .filter(
          (a) =>
            Object.keys(a.jobs)
              .map((jk) => a.jobs[jk])
              .filter((index_) => index_.ISTIMEOUT).length > 1
        );

      console.log(
        `  ${day}: Have ${timeouts.length} timeout errors:`,
        timeouts.map((index_) => ({
          key: index_.key,
          id: index_.id,
          looksLegit: index_.looksLegit,
          lastjobIsSuccess: index_.lastjob?.ISSUCCESS,
          lastjobIsTimeout: index_.lastjob?.ISTIMEOUT,
        }))
      );

      const errors = Object.keys(asninfo)
        .map((ak) => asninfo[ak])
        .filter((a) => !a.lastjob?.ISSUCCESS);
      console.log(
        `  ${day}: Have ${errors.length} error jobs as the last job for an asn:`,
        errors.map((e) => ({
          key: e.key,
          id: e.id,
          looksLegit: e.looksLegit,
          lastjobIsSuccess: e.lastjob?.ISSUCCESS,
          lastjobIsTimeout: e.lastjob?.ISTIMEOUT,
        }))
      );
    });

    process.exit(0);
  } catch (error) {
    console.log('ERROR:', error);
  } finally {
    process.exit(0);
  }
})();
