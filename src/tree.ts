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

/* eslint-disable sonarjs/no-duplicate-string */

import type Tree from '@oada/types/oada/tree/v1.js';

const documents: Tree = {
  '_type': 'application/vnd.trellisfw.documents.1+json',
  '*': {
    '_type': 'application/vnd.trellisfw.documents.1+json',
    '*': {
      _type: 'application/vnd.trellisfw.document.1+json',
    },
  },
};

const tree: Tree = {
  bookmarks: {
    _type: 'application/vnd.oada.bookmarks.1+json',
    trellisfw: {
      '_type': 'application/vnd.trellisfw.1+json',
      'coi-holders': {
        '_type': 'application/vnd.trellisfw.trading-partners.1+json',
        'expand-index': {
          _type: 'application/vnd.trellisfw.trading-partners.1+json',
        },
      },
      'trading-partners': {
        '_type': 'application/vnd.trellisfw.trading-partners.1+json',
        '*': {
          _type: 'application/vnd.trellisfw.trading-partner.1+json',
          bookmarks: {
            _type: 'application/vnd.oada.bookmarks.1+json',
            trellisfw: {
              '_type': 'application/vnd.trellisfw.1+json',
              documents,
              'fsqa-audits': {
                _type: 'application/vnd.trellisfw.fsqa-audits.1+json',
              },
              'cois': {
                _type: 'application/vnd.trellisfw.cois.1+json',
              },
            },
          },
          shared: {
            _type: 'application/vnd.oada.bookmarks.1+json',
            trellisfw: {
              '_type': 'application/vnd.trellisfw.1+json',
              documents,
              'fsqa-audits': {
                _type: 'application/vnd.trellisfw.fsqa-audits.1+json',
              },
              'cois': {
                _type: 'application/vnd.trellisfw.cois.1+json',
              },
            },
          },
        },
        'masterid-index': {
          '_type': 'application/vnd.trellisfw.trading-partners.1+json',
          '*': {
            _type: 'application/vnd.trellisfw.trading-partner.1+json',
            bookmarks: {
              _type: 'application/vnd.oada.bookmarks.1+json',
              trellisfw: {
                '_type': 'application/vnd.trellisfw.1+json',
                documents,
                'fsqa-audits': {
                  _type: 'application/vnd.trellisfw.fsqa-audits.1+json',
                },
                'cois': {
                  _type: 'application/vnd.trellisfw.cois.1+json',
                },
                '*': {
                  '_type': 'application/vnd.trellisfw.doctype.1+json',
                  '*': {
                    _type: 'application/vnd.trellisfw.document.1+json',
                  },
                },
              },
            },
            shared: {
              _type: 'application/vnd.oada.bookmarks.1+json',
              trellisfw: {
                '_type': 'application/vnd.trellisfw.1+json',
                documents,
                'fsqa-audits': {
                  _type: 'application/vnd.trellisfw.fsqa-audits.1+json',
                },
                'cois': {
                  _type: 'application/vnd.trellisfw.cois.1+json',
                },
              },
            },
          },
        },
      },
      documents,
      'asns': {
        '_type': 'application/vnd.trellisfw.asns.1+json',
        'day-index': {
          '*': {
            '_type': 'application/vnd.trellisfw.asns.1+json',
            '*': {
              _type: 'application/vnd.trellisfw.asn.sf.1+json',
            },
          },
        },
      },
    },
    services: {
      '_type': 'application/vnd.oada.services.1+json',
      '*': {
        // We will post to shares/jobs
        _type: 'application/vnd.oada.service.1+json',
        jobs: {
          _type: 'application/vnd.oada.service.jobs.1+json',
          pending: {
            '_type': 'application/vnd.oada.service.jobs.1+json',
            '*': {
              _type: 'application/vnd.oada.service.job.1+json',
              _rev: 0,
            },
          },
        },
      },
    },
  },
};

export default tree;
export { type TreeKey } from '@oada/types/oada/tree/v1.js';
