/**
 * @license
 * Copyright 2021 Qlever LLC
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { Json, WorkerFunction } from '@oada/jobs';
import type { Link } from '@oada/types/oada/link/v1.js';
import type { Logger } from '@oada/pino-debug';
import type { OADAClient } from '@oada/client';
import { assert as assertJob } from '@oada/types/oada/service/job.js';

import { handleJob } from './pdfJob.js';
import { recursiveReplaceLinksWithReferences } from './utils.js';
import { recursiveSignLinks } from './pdfJobPostProc.js';

const pending = '/bookmarks/services/target/jobs/pending';

type List<T> = Record<string, T>;

/**
 * Receive the job from oada-jobs
 */
export const jobHandler: WorkerFunction = async (job, { jobId, log, oada }) => {
  log.trace({ job }, 'Received job');
  // Until oada-jobs adds cross-linking, make sure we are linked under the PDF's jobs
  log.trace('Linking job under pdf/_meta until oada-jobs can do that natively');
  // TODO: This seems broken when it writes to the target job
  const jobKey = jobId.replace(/^resources\//, '');
  await oada.put({
    path: `${pending}/${jobKey}/config/pdf/_meta/services/target/jobs`,
    data: {
      [jobKey]: { _ref: `${jobId}` },
    },
  });

  return handleJob({ jobId, log, oada, onTargetSuccess: targetSuccess });
};

async function targetSuccess({
  jobId,
  log,
  oada,
}: {
  jobId: string;
  log: Logger;
  oada: OADAClient;
}): Promise<Json> {
  log.info(
    'helper-started',
    'Target returned success, target-helper picking up',
  );

  // Get the latest copy of job
  const r = await oada.get({ path: `/${jobId}` });
  assertJob(r.data);
  const job = r.data as unknown as TranscriptionOnlyJob;
  const pdfId = job.config.pdf._id;

  // ------------- 1: get result from targetResult
  job.result = job.targetResult;
  await oada.put({
    path: `/${jobId}`,
    data: {
      result: job.result as Json,
    },
  });

  // ------------- 2: sign audit/coi/etc.
  if (job.config.sign) {
    log.info('helper: signing all links in result', {});
    await recursiveSignLinks(job.result, oada, log);
  }

  // ------------- 3: cross link vdoc for pdf <-> audits,cois,letters,etc.
  if (job.config.useRefs) {
    log.info(
      'link-refs-pdf',
      'helper: linking result _refs under <pdf>/_meta/vdoc',
    );
    const vdoc = recursiveReplaceLinksWithReferences(job.result);
    log.info(
      "Linking _ref's into pdf/_meta, job.result before: %O, after: %O",
      job.result,
      vdoc,
    );
    await oada.put({
      path: `/${pdfId}/_meta`,
      data: {
        // E.g., fsqa-audits { ...links... }, or fsqa-certificates { ...links... }, etc.
        vdoc: vdoc as Json,
      },
    });
  }

  log.info('done', 'Completed all helper tasks');

  return job.result as Json;
}

interface TranscriptionOnlyJobConfig {
  type: 'pdf';
  pdf: {
    _id: string;
  };
  sign?: boolean;
  useRefs?: boolean;
}

interface TranscriptionOnlyJob {
  'config': TranscriptionOnlyJobConfig;
  'trading-partner': string;
  'targetResult': List<List<Link>>;
  'result': List<List<Link>>;
}
