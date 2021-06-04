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

import convict from 'convict';
// @ts-ignore
import convictMoment from 'convict-format-with-moment';
import convictValidator from 'convict-format-with-validator';
import { config as load } from 'dotenv';

load();

convict.addFormats(convictMoment);
convict.addFormats(convictValidator);

const config = convict({
  oada: {
    domain: {
      doc: 'OADA API domain',
      format: String,
      default: 'proxy',
      env: 'DOMAIN',
      arg: 'domain',
    },
    token: {
      doc: 'OADA API token',
      format: Array,
      default: ['god-proxy'],
      env: 'TOKEN',
      arg: 'token',
    },
  },
  timeouts: {
    pdf: {
      doc: 'Timeout duration for PDF jobs',
      format: 'duration',
      // The types for duration suck
      default: ('1h' as unknown) as number,
    },
    asn: {
      doc: 'Timeout duration for ASN jobs',
      format: 'duration',
      // The types for duration suck
      default: ('1h' as unknown) as number,
    },
  },
  slack: {
    posturl: {
      format: 'url',
      // use a real slack webhook URL
      default: 'https://localhost',
    },
  },
  signing: {
    signatureType: {
      format: String,
      default: 'transcription',
    },
    privateJWK: {
      format: String,
      default: './keys/private_key.jwk',
    },
    signer: {
      name: {
        format: String,
        default: 'Test signer',
      },
      url: {
        format: 'url',
        default: 'https://oatscenter.org',
      },
    },
  },
  tradingPartnersEnabled: true,
});

config.validate({ allowed: 'warn' });

export default config;
