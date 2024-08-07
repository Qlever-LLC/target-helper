/**
 * @license
 *  Copyright 2021 Qlever LLC
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

// Load config first so it can set up env
import config from './config.js';

// Needs to be imported _before_ debug
import '@oada/pino-debug';

import debug from 'debug';

import '@oada/lib-prom';
import { Service } from '@oada/jobs';

/* Import {
  jobHandler as asnJobHandler,
  startJobCreator as asnStartJobCreator,
  } from './asnJob.js';
*/
import {
  jobHandler as pdfJobHandler,
  startJobCreator as pdfStartJobCreator,
} from './pdfJob.js';
import { jobHandler as transcriptionOnlyJobHandler } from './transcriptionOnly.js';

const error = debug('target-helper:error');
const info = debug('target-helper:info');
const trace = debug('target-helper:trace');
const warn = debug('target-helper:warn');

const tokens = config.get('oada.token');
const domain = config.get('oada.domain');
const jobsConcurrency = config.get('oada.jobsConcurrency');
if (domain.startsWith('http')) {
  //  Domain = domain.replace(/^https?:\/\//, '');
}

trace('Using token(s) = %s', tokens);
info('Using domain = %s', domain);

process.on('unhandledRejection', (reason, promise) => {
  warn({ promise, reason }, 'Unhandled Rejection');
  // Application specific logging, throwing an error, or other logic here
});

// Handle each token concurrently
await Promise.all(
  tokens.map(async (token) => {
    // --------------------------------------------------
    // Create the service
    const service = new Service({
      name: 'target',
      oada: { domain, token },
      opts: {
        finishReporters: [
          {
            type: 'slack',
            status: 'failure',
            posturl: config.get('slack.posturl'),
          },
        ],
      },
      concurrency: jobsConcurrency,
    });

    // --------------------------------------------------
    // Set the job type handlers; don't timeout jobs due to other jobs taking too long
    service.on(
      'transcription',
      config.get('timeouts.pdf') * jobsConcurrency,
      pdfJobHandler,
    );

    service.on(
      'transcription-only',
      config.get('timeouts.pdf') * jobsConcurrency,
      transcriptionOnlyJobHandler,
    );
    // Service.on('asn', config.get('timeouts.asn'), asnJobHandler);

    // --------------------------------------------------
    // Start the jobs watching service
    info(
      `Initializing target-helper service. Version: ${process.env.npm_package_version}`,
    );
    const serviceP = service.start();

    // Start the things watching to create jobs
    info('Started pdf job creator processes');
    const pdfP = pdfStartJobCreator({ domain, token });
    //    Const asnP = asnStartJobCreator({ domain, token });

    // Catch errors?
    try {
      await Promise.all([serviceP, pdfP]);
    } catch (cError: unknown) {
      error(cError);
      // eslint-disable-next-line no-process-exit, unicorn/no-process-exit
      process.exit(1);
    }

    info('Ready');
  }),
);
