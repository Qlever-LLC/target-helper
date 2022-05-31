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

import assign from 'assign-deep';
import cloneDeep from 'clone-deep';
import debug from 'debug';
import { JsonPointer } from 'json-ptr';
import moment from 'moment';

import type { OADAClient } from '@oada/client';

const trace = debug('target-helper#test:trace');
const info = debug('target-helper#test:info');
const error = debug('target-helper#test:error');

let con: OADAClient; // Set with setConnection function

const tree = {
  bookmarks: {
    _type: 'application/vnd.oada.bookmarks.1+json',
    services: {
      _type: 'application/vnd.oada.services.1+json',
      target: {
        _type: 'application/vnd.oada.service.1+json',
        jobs: {
          _type: 'application/vnd.oada.jobs.1+json',
          pending: {
            '_type': 'application/vnd.oada.jobs.1+json',
            '*': {
              _type: 'application/vnd.oada.job.1+json',
            },
          },
          success: {
            '_type': 'application/vnd.oada.jobs.1+json',
            '*': {
              _type: 'application/vnd.oada.job.1+json',
            },
          },
          failure: {
            '_type': 'application/vnd.oada.jobs.1+json',
            '*': {
              _type: 'application/vnd.oada.job.1+json',
            },
          },
        },
      },
    },
    trellisfw: {
      _type: 'application/vnd.trellisfw.1+json',
    },
  },
};

interface Item {
  key?: string;
  name: { singular: string; plural?: string };
  source?: string;
  list?: string;
  notversioned?: boolean;
  _type?: string;
  list_type?: string;
  data?: {
    [k: string]: unknown;
    'iam'?: string;
    'masterid'?: string;
    'name'?: string;
    'user'?: { id: string; bookmarks: { _id: string } };
    'holder'?: { name: string };
    'organization'?: { location: { name: string } };
    'facilities'?: Record<string, { _id: string }>;
    'trading-partners'?: Record<string, { _id: string }>;
  };
  cleanup?: { lists?: readonly string[] };
}

// Fill out tree, and let code fill in any "defaults" later.
// One "item" will have:
// name.singular, name.plural, data, source (oada|trellisfw), list, _type, list_type, and key.
const day = moment().format('YYYY-MM-DD');
const jobtemplate: Item = {
  source: 'oada',
  name: { singular: 'job' },
  list: '/bookmarks/services/target/jobs/pending',
  notversioned: true, // Do not make this a versioned link in it's list
  cleanup: {
    lists: [
      `/bookmarks/services/target/jobs/success/day-index/${day}`,
      `/bookmarks/services/target/jobs/failure/day-index/${day}`,
    ],
  },
};

const baseItems: Record<string, Item> = {
  coijob: cloneDeep(jobtemplate),
  auditjob: cloneDeep(jobtemplate),
  certjob: cloneDeep(jobtemplate),
  logjob: cloneDeep(jobtemplate),

  // -------------------------------------
  // Documents:
  pdf: {
    name: { singular: 'document' },
  },
  coi: {
    name: { singular: 'coi' },
    data: {
      holder: { name: 'a test coi holder' },
    },
  },
  audit: {
    name: { singular: 'fsqa-audit' },
    data: {
      organization: {
        location: {
          name: 'a test facility',
        },
      },
    },
  },
  cert: {
    name: { singular: 'fsqa-certificate' },
    data: {
      organization: {
        location: {
          name: 'a test facility',
        },
      },
    },
  },
  log: {
    name: { singular: 'letter-of-guarantee', plural: 'letters-of-guarantee' },
    data: {
      buyer: { name: 'a test log buyer' },
    },
  },

  // -------------------------------------
  // Master Data:
  tp: {
    name: { singular: 'trading-partner' },
    data: {
      masterid: 'test-master-tp-1', // Triggers an expand-index and masterid-index
      name: 'a test trading partner',
      // Note: this user doesn't actually exist
      user: {
        id: 'users/TEST-TARGETHELPER-TPUSER',
        bookmarks: { _id: 'resources/TEST-TARGETHELPER-TPUSERBOOKMARKS' },
      },
    },
  },
  fac: {
    name: { singular: 'facility', plural: 'facilities' },
    data: {
      masterid: 'test-master-fac-1', // Triggers an expand-index and masterid-index
      name: 'a test facility',
    },
  },
  coiholder: {
    name: { singular: 'coi-holder' },
    data: {
      masterid: 'test-master-coiholder-1', // Triggers an expand-index and masterid-index
      name: 'a test coi holder',
    },
  },
  logbuyer: {
    name: {
      singular: 'letter-of-guarantee-buyer',
    },
    data: {
      masterid: 'test-master-logbuyer-1', // Triggers an expand-index and masterid-index
      name: 'a test logbuyer',
    },
  },
};

// Fill out all missing things with defaults
const items = Object.fromEntries(
  Object.entries(baseItems).map(
    ([
      k,
      {
        name: { singular, plural = `${singular}s` },
        source = 'trellisfw',
        list = `/bookmarks/${source}/${plural}`,
        _type = `application/vnd.${source}.${singular}.1+json`,
        // eslint-disable-next-line @typescript-eslint/naming-convention
        list_type = `application/vnd.${source}.${plural}.1+json`,
        data = { iam: k },
        ...rest
      },
    ]) => {
      const listPtr = new JsonPointer(list);
      const key = `TEST-TARGETHELPER-${k.toUpperCase()}`; // Default key
      // Also, fill out the tree for this list:
      if (!listPtr.get(tree)) {
        listPtr.set(tree, { _type: list_type });
      }

      // Add the '*' entry to the list in the tree:
      const ptr = listPtr.concat('*');
      if (!ptr.get(tree)) {
        ptr.set(tree, { _type });
      }

      if (data.masterid) {
        // This is masterdata, add the expand-index and masterid-index to the tree
        const expandPtr = listPtr.concat('expand-index');
        if (!expandPtr.get(tree)) {
          expandPtr.set(tree, { _type: list_type });
        }

        const masterPtr = listPtr.concat('masterid-index');
        if (!masterPtr.get(tree)) {
          masterPtr.set(tree, { _type: list_type });
        }
      }

      return [
        k,
        {
          ...rest,
          name: { singular, plural },
          source,
          list,
          _type,
          list_type,
          data,
          key,
        },
      ];
    }
  )
);
// And finally, any inter-item relationships between master data:
items.tp!.data.facilities = {
  [items.fac!.key]: { _id: `resources/${items.fac!.key}` },
};
items.coiholder!.data['trading-partners'] = {
  [items.tp!.key]: { _id: `resources/${items.tp!.key}` },
};
items.logbuyer!.data['trading-partners'] = {
  [items.tp!.key]: { _id: `resources/${items.tp!.key}` },
};

async function cleanup(keyOrKeys?: string | readonly string[]) {
  const keys = Array.isArray(keyOrKeys)
    ? keyOrKeys
    : keyOrKeys
    ? [keyOrKeys]
    : (Object.keys(items) as Array<keyof typeof items>);
  info('cleanup: removing any lingering test resources');

  for await (const k of keys) {
    trace('cleanup: removing resources+links if they exist for key %s', k);
    const index = items[k as keyof typeof items]!;
    let path;
    // Delete the link path from the list:
    path = `${index.list}/${index.key}`;
    try {
      await con.get({ path });
      await con.delete({ path });
    } catch {}

    // Delete the actual resource for this thing too:
    path = `/resources/${index.key}`;
    try {
      await con.get({ path });
      await con.delete({ path });
    } catch {}

    if (index.data?.masterid) {
      // This is master data, so remove from masterid-index and expand-index
      path = `${index.list}/expand-index/${index.key}`;
      try {
        await con.get({ path });
        await con.delete({ path });
      } catch {}

      path = `${index.list}/masterid-index/${index.data.masterid}`;
      try {
        await con.get({ path });
        await con.delete({ path });
      } catch {}
    }

    // If there are extra lists to cleanup (like for jobs-success), do those too:
    if (index.cleanup?.lists) {
      for await (const l of index.cleanup.lists) {
        path = `${l}/${index.key}`;
        try {
          await con.get({ path });
          await con.delete({ path });
        } catch {}
      }
    }
  }
}

async function putData(
  keyOrKeys: string | readonly string[],
  merges?: unknown
) {
  let keys = Object.keys(items);
  let dataMerges: unknown[] = [];
  if (Array.isArray(keyOrKeys)) {
    keys = keyOrKeys as string[];
    dataMerges = (merges as unknown[]) ?? [];
  } else if (keyOrKeys) {
    keys = [keyOrKeys as string];
    dataMerges = [merges];
  }

  for await (const [ki, k] of Object.entries(keys)) {
    trace('putData: adding test data for key: %s', k);
    // eslint-disable-next-line security/detect-object-injection
    const index = items[k]!;
    let data: unknown;

    // Make the resource:
    const path = `/resources/${index.key}`;
    // Merge in any data overrides:
    data = index.data;
    if (dataMerges[Number(ki)]) {
      data = assign(data, dataMerges[Number(ki)]);
    }

    // Do the put:
    trace('putData: path: ', path, ', data = ', data);
    try {
      await con.put({
        path,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
        data: data as any,
        contentType: index._type,
      });
    } catch (error_: unknown) {
      error(
        'Failed to make the resource. path = ',
        path,
        ', data = ',
        index.data,
        ', _type = ',
        index._type,
        ', error = ',
        error_
      );
      throw error_ as Error;
    }

    // If this has a user, go ahead and make their dummy bookmarks resource (i.e. a trading-partner)
    if (index.data.user?.bookmarks) {
      try {
        await con.put({
          path: `/${index.data.user.bookmarks._id}`,
          // FIXME: contentType: tree.bookmarks,
          data: { iam: 'userbookmarks' },
        });
      } catch (error_: unknown) {
        error(
          'Failed to make bookmarks for i.data.user. path = /',
          index.data.user.bookmarks._id,
          ', error = ',
          error_
        );
        throw error_ as Error;
      }
    }
  }
}

async function putLink(keyOrKeys?: string | readonly string[]) {
  const keys = Array.isArray(keyOrKeys)
    ? keyOrKeys
    : keyOrKeys
    ? [keyOrKeys]
    : (Object.keys(items) as Array<keyof typeof items>);

  for await (const k of keys) {
    // eslint-disable-next-line security/detect-object-injection
    const index = items[k]!;
    trace(
      'putLink: linking test data for key: ',
      k,
      ', under list ',
      index.list
    );
    let path;

    // Link under the list:
    path = `${index.list}`;
    // NOTE: since we are doing a tree put, do NOT put the i.key on the end of the URL
    // because tree put will create a new resource instead of linking the existing one.
    const data = {
      [index.key]: { _id: `resources/${index.key}` },
      _rev: index.notversioned ? undefined : 0,
    };

    try {
      await con.put({ path, data, tree });
    } catch (error_: unknown) {
      error(
        'Failed to link the resource. path = ',
        path,
        ', data = ',
        data,
        ', error = ',
        error_
      );
      throw error_ as Error;
    }

    if (index.data.masterid) {
      // This is master data, so put it into the expand-index and masterid-index
      const masterMada = cloneDeep(index.data);
      masterMada.id = `resources/${index.key}`;
      // Put the expand-index:
      path = `${index.list}/expand-index`;
      try {
        await con.put({
          path,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
          data: { [index.key]: masterMada } as any,
          tree,
        });
      } catch (error_: unknown) {
        error(error_, 'Failed to put the expand-index');
        throw error_ as Error;
      }

      // Put the masterid-index:
      path = `${index.list}/masterid-index`;
      try {
        await con.put({
          path,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
          data: { [index.data.masterid]: masterMada } as any,
          tree,
        });
      } catch (error_: unknown) {
        error(error_, 'Failed to put the masterid-index');
        throw error_ as Error;
      }
    }
  }
}

async function putAndLinkData(
  keyOrKeys: string | readonly string[],
  merges?: unknown
) {
  await putData(keyOrKeys, merges);
  await putLink(keyOrKeys);
}

function setConnection(theconnection: OADAClient) {
  con = theconnection;
}

export {
  tree,
  items,
  cleanup,
  putData,
  putLink,
  putAndLinkData,
  setConnection,
};
