/* Copyright 2021 Qlever LLC
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
import 'make-promises-safe';

import { Service } from '@oada/jobs';

import * as pdf from './pdfJob';
import * as asn from './asnJob';
import config from './config';

const error = debug('target-helper:error');
const info = debug('target-helper:info');
const trace = debug('target-helper:trace');

const tokens = config.get('oada.token');
let domain = config.get('oada.domain');
if (domain.match(/^http/)) {
  domain = domain.replace(/^https?:\/\//, '');
}

if (domain === 'localhost' || domain === 'proxy') {
  // @ts-ignore
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;
}

trace('Using token(s) = %s', tokens);
info('Using domain = %s', domain);

for (const token of tokens) {
  //--------------------------------------------------
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

  //--------------------------------------------------
  // Set the job type handlers
  service.on('transcription', config.get('timeouts.pdf'), pdf.jobHandler);
  service.on('asn', config.get('timeouts.asn'), asn.jobHandler);

  //--------------------------------------------------
  // Start the jobs watching service
  const servicep = service.start();

  // Start the things watching to create jobs
  const pdfp = pdf.startJobCreator({ domain, token });
  const asnp = asn.startJobCreator({ domain, token });

  // Catch errors
  Promise.all([servicep, pdfp, asnp]).catch((err) => {
    error(err);
    process.exit(1);
  });

  info("Initializing target-helper service. v1.1.9");
  info('Started pdf and asn job creator processes');
  info('Ready');
}
