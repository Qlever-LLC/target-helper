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

import config from '../dist/config.js';

import test from 'ava';

import { connect } from '@oada/client';
import { doJob } from '@oada/client/jobs';

const con = await connect({
  domain: config.get('oada.domain'),
  token: config.get('oada.token')[0],
});

test.only('Should process jobs created outside of the trading-partners lists', async (t) => {
  t.timeout(3_000_000);
  const jobResult = await doJob(con, {
    'service': 'target',
    'type': 'transcription',
    'trading-partner': 'resources/2QZVLGtY7o2F4txRXTTWtseb6Fx',
    'config': {
      'type': 'pdf',
      'pdf': {
        _id: 'resources/57fa585a6c69a0c48904c5ed8586786bcef1db58ace58f1f9c2c59ea2279650c-pdf',
      },
      'document': {
        _id: 'resources/2QtQ9oRFcn8SC03pIVwNoDxEVvu',
      },
      'docKey': '11d5d18fee6c9b3d923763cc28542084',
      'document-type': 'application/vnd.trellisfw.coi.accord.1+json',
      'oada-doc-type': 'cois',
    },
  });
  t.truthy(jobResult);
  console.log(jobResult);
});
