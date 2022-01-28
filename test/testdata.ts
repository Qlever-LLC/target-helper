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

import _ from 'lodash';
import debug from 'debug';
import jp from 'jsonpointer';
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
        '_type': 'application/vnd.oada.service.1+json',
        'jobs': {
          '_type': 'application/vnd.oada.jobs.1+json',
          '*': {
            _type: 'application/vnd.oada.job.1+json',
          },
        },
        'jobs-success': {
          '_type': 'application/vnd.oada.jobs.1+json',
          '*': {
            _type: 'application/vnd.oada.job.1+json',
          },
        },
        'jobs-failure': {
          '_type': 'application/vnd.oada.jobs.1+json',
          '*': {
            _type: 'application/vnd.oada.job.1+json',
          },
        },
      },
    },
    trellisfw: {
      _type: 'application/vnd.trellisfw.1+json',
    },
  },
};

// Fill out tree, and let code fill in any "defaults" later.
// One "item" will have:
// name.singular, name.plural, data, source (oada|trellisfw), list, _type, list_type, and key.
const day = moment().format('YYYY-MM-DD');
const jobtemplate = {
  source: 'oada',
  name: { singular: 'job' },
  list: '/bookmarks/services/target/jobs',
  notversioned: true, // Do not make this a versioned link in it's list
  cleanup: {
    lists: [
      `/bookmarks/services/target/jobs-success/day-index/${day}`,
      `/bookmarks/services/target/jobs-failure/day-index/${day}`,
    ],
  },
};
const items = {
  coijob: _.cloneDeep(jobtemplate),
  auditjob: _.cloneDeep(jobtemplate),
  certjob: _.cloneDeep(jobtemplate),
  logjob: _.cloneDeep(jobtemplate),

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
// Fill out all missing things with defaults:
_.each(items, (index, k) => {
  index.key = `TEST-TARGETHELPER-${k.toUpperCase()}`; // Default key
  if (!index.name.plural) index.name.plural = `${index.name.singular}s`; // Default plural
  if (!index.source) index.source = 'trellisfw'; // Default source
  if (!index.list)
    index.list = `/bookmarks/${index.source}/${index.name.plural}`; // Default list
  if (!index.data) index.data = { iam: k }; // Default data
  if (!index._type)
    index._type = `application/vnd.${index.source}.${index.name.singular}.1+json`;
  if (!index.list_type)
    index.list_type = `application/vnd.${index.source}.${index.name.plural}.1+json`;
  // Also, fill out the tree for this list:
  if (!jp.get(tree, index.list)) {
    jp.set(tree, index.list, { _type: index.list_type });
  }

  // Add the '*' entry to the list in the tree:
  let path = `${index.list}/*`;
  if (!jp.get(tree, path)) {
    jp.set(tree, path, { _type: index._type });
  }

  if (index.data.masterid) {
    // This is masterdata, add the expand-index and masterid-index to the tree
    path = `${index.list}/expand-index`;
    if (!jp.get(tree, path)) {
      jp.set(tree, path, { _type: index.list_type });
    }

    path = `${index.list}/masterid-index`;
    if (!jp.get(tree, path)) {
      jp.set(tree, path, { _type: index.list_type });
    }
  }
});
// And finally, any inter-item relationships between master data:
items.tp.data.facilities = {
  [items.fac.key]: { _id: `resources/${items.fac.key}` },
};
items.coiholder.data['trading-partners'] = {
  [items.tp.key]: { _id: `resources/${items.tp.key}` },
};
items.logbuyer.data['trading-partners'] = {
  [items.tp.key]: { _id: `resources/${items.tp.key}` },
};

async function cleanup(keyOrKeys?: string | readonly string[]) {
  let keys = _.keys(items);
  if (_.isArray(keyOrKeys)) keys = keyOrKeys;
  else if (keyOrKeys) keys = [keyOrKeys];
  info('cleanup: removing any lingering test resources');

  for await (const k of keys) {
    trace('cleanup: removing resources+links if they exist for key ', k);
    const index = items[k];
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

    if (index.data.masterid) {
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

async function putData(keyOrKeys, merges) {
  let keys = _.keys(items);
  let dataMerges = [];
  if (_.isArray(keyOrKeys)) {
    keys = keyOrKeys;
    dataMerges = merges || [];
  } else if (keyOrKeys) {
    keys = [keyOrKeys];
    dataMerges = [merges];
  }

  for await (const [ki, k] of Object.entries(keys)) {
    trace('putData: adding test data for key: ', k);
    const index = items[k];
    let data;

    // Make the resource:
    const path = `/resources/${index.key}`;
    // Merge in any data overrides:
    data = index.data;
    if (dataMerges[ki]) data = _.merge(data, dataMerges[ki]);
    // Do the put:
    trace('putData: path: ', path, ', data = ', data);
    try {
      await con.put({ path, data, _type: index._type });
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
      throw error_;
    }

    // If this has a user, go ahead and make their dummy bookmarks resource (i.e. a trading-partner)
    if (index.data.user && index.data.user.bookmarks) {
      try {
        await con.put({
          path: `/${index.data.user.bookmarks._id}`,
          _type: tree.bookmarks,
          data: { iam: 'userbookmarks' },
        });
      } catch (error_: unknown) {
        error(
          'Failed to make bookmarks for i.data.user. path = /',
          index.data.user.bookmarks._id,
          ', error = ',
          error_
        );
        throw error_;
      }
    }
  }
}

async function putLink(keyOrKeys) {
  let keys = _.keys(items);
  if (_.isArray(keyOrKeys)) keys = keyOrKeys;
  else if (keyOrKeys) keys = [keyOrKeys];

  await Promise.each(keys, async (k) => {
    const index = items[k];
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
    const data = { [index.key]: { _id: `resources/${index.key}` } };
    if (!index.notversioned) {
      data._rev = 0;
    }

    try {
      await con.put({ path, data, tree });
    } catch (error_) {
      error(
        'Failed to link the resource. path = ',
        path,
        ', data = ',
        data,
        ', error = ',
        error_
      );
      throw error_;
    }

    if (index.data.masterid) {
      // This is master data, so put it into the expand-index and masterid-index
      const masterMada = _.cloneDeep(index.data);
      masterMada.id = `resources/${index.key}`;
      // Put the expand-index:
      path = `${index.list}/expand-index`;
      try {
        await con.put({ path, data: { [index.key]: masterMada }, tree });
      } catch (error_) {
        error('Failed to put the expand-index.  e = ', error_);
        throw error_;
      }

      // Put the masterid-index:
      path = `${index.list}/masterid-index`;
      try {
        await con.put({
          path,
          data: { [index.data.masterid]: masterMada },
          tree,
        });
      } catch (error_) {
        error('Failed to put the masterid-index.  e = ', error_);
        throw error_;
      }
    }
  });
}

async function putAndLinkData(keyOrKeys, merges) {
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
