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

import 'dotenv/config';

import convict from 'convict';
// @ts-expect-error has no types
import convictMoment from 'convict-format-with-moment';
import convictValidator from 'convict-format-with-validator';

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
    concurrency: {
      doc: 'OADA client concurrency',
      format: Number,
      default: 1,
      env: 'CONCURRENCY',
      arg: 'concurrency',
    },
  },
  timeouts: {
    pdf: {
      doc: 'Timeout duration for PDF jobs',
      format: 'duration',
      // The types for duration suck
      default: 3_600_000 as unknown as number,
      env: 'PDF_TIMEOUT',
      arg: 'pdf-timeout',
    },
    asn: {
      doc: 'Timeout duration for ASN jobs',
      format: 'duration',
      // The types for duration suck
      default: 3_600_000 as unknown as number,
      env: 'ASN_TIMEOUT',
      arg: 'asn-timeout',
    },
  },
  slack: {
    posturl: {
      format: 'url',
      // Use a real slack webhook URL
      default: 'https://localhost',
      env: 'SLACK_WEBHOOK',
      arg: 'slack-webhook',
    },
  },
  signing: {
    signatureType: {
      format: String,
      default: 'transcription',
      env: 'SIGNATURE_TYPE',
      arg: 'signature-type',
    },
    privateJWK: {
      format: String,
      default: './keys/private_key.jwk',
      env: 'SIGNATURE_JWK',
      arg: 'signature-jwk',
    },
    signer: {
      name: {
        format: String,
        default: 'Test signer',
        env: 'SIGNER_NAME',
        arg: 'signer-name',
      },
      url: {
        format: 'url',
        default: 'https://oatscenter.org',
        env: 'SIGNER_URL',
        arg: 'signer-ul',
      },
    },
  },
  tradingPartnersEnabled: {
    format: Boolean,
    default: true,
    env: 'ENABLE_TRADING_PARTNERS',
    arg: 'enable-trading-partners',
  },
});

config.validate({ allowed: 'warn' });

export default config;
