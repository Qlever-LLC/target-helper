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

import debug from 'debug';

import { Service } from '@oada/jobs';

import {
  jobHandler as asnJobHandler,
  startJobCreator as asnStartJobCreator,
} from './asnJob.js';
import {
  jobHandler as pdfJobHandler,
  startJobCreator as pdfStartJobCreator,
} from './pdfJob.js';
import config from './config.js';

const error = debug('target-helper:error');
const info = debug('target-helper:info');
const trace = debug('target-helper:trace');

const tokens = config.get('oada.token');
let domain = config.get('oada.domain');
if (domain.startsWith('http')) {
  domain = domain.replace(/^https?:\/\//, '');
}

if (domain === 'localhost' || domain === 'proxy') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

trace('Using token(s) = %s', tokens);
info('Using domain = %s', domain);

for (const token of tokens) {
  // --------------------------------------------------
  // Create the service
  const service = new Service('target', domain, token, 1, {
    finishReporters: [
      {
        type: 'slack',
        status: 'failure',
        posturl: config.get('slack.posturl'),
      },
    ],
  }); // 1 concurrent job

  // --------------------------------------------------
  // Set the job type handlers
  service.on('transcription', config.get('timeouts.pdf'), pdfJobHandler);
  service.on('asn', config.get('timeouts.asn'), asnJobHandler);

  // --------------------------------------------------
  // Start the jobs watching service
  const serviceP = service.start();

  // Start the things watching to create jobs
  const pdfP = pdfStartJobCreator({ domain, token });
  const asnP = asnStartJobCreator({ domain, token });

  // Catch errors
  // eslint-disable-next-line github/no-then
  Promise.all([serviceP, pdfP, asnP]).catch((cError) => {
    error(cError);
    // eslint-disable-next-line no-process-exit, unicorn/no-process-exit
    process.exit(1);
  });

  info('Initializing target-helper service. v1.1.9');
  info('Started pdf and asn job creator processes');
  info('Ready');
}
