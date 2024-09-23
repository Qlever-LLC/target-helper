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

/* eslint-disable complexity */

import { connect } from '@oada/client';
import config from './dist/config.js';
import tree from './dist/tree.js';
import { setTimeout } from 'node:timers/promises';

const domain = config.get('oada.domain');
const token = config.get('oada.token');

async function main() {
  const conn = await connect({
    domain,
    token,
  });

  await conn.delete({
    path: `/bookmarks/trellisfw/trading-partners/masterid-index/d4f7b367c7f6aa30841132811bbfe95d3c3a807513ac43d7c8fea41a6688606e/shared/trellisfw/documents/gfsi-certificates`,
    //path: `/bookmarks/trellisfw/trading-partners/masterid-index/d4f7b367c7f6aa30841132811bbfe95d3c3a807513ac43d7c8fea41a6688606e/shared/trellisfw/documents/gfsi-certificates/a45717de48be4a5ab6d61af7cfeb8d55`,
  });

  console.log('deleted');
  await setTimeout(3000);

  await conn.put({
    path: `/bookmarks/trellisfw/trading-partners/masterid-index/d4f7b367c7f6aa30841132811bbfe95d3c3a807513ac43d7c8fea41a6688606e/shared/trellisfw/documents/gfsi-certificates`,
    data: {},
    tree,
  });

  console.log('put1');
  await setTimeout(10000);

  await conn.put({
    path: `/bookmarks/trellisfw/trading-partners/masterid-index/d4f7b367c7f6aa30841132811bbfe95d3c3a807513ac43d7c8fea41a6688606e/shared/trellisfw/documents/gfsi-certificates`,
    data: {
      'a45717de48be4a5ab6d61af7cfeb8d55': {
        _id: 'resources/2HxK1NmfiFaWVFdDw8e1GIdh2Ua',
        _rev: 0,
      },
    },
    tree,
  });

  console.log('put');
}

main();