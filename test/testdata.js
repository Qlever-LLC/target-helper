const _ = require('lodash');
const jp = require('jsonpointer');
const Promise = require('bluebird');
const debug = require('debug');
const moment = require('moment');

const trace = debug('target-helper#test:trace')
const info = debug('target-helper#test:info')
const error = debug('target-helper#test:error')


let con = false; // set with setConnection function

const tree = {
  bookmarks: {
    _type: 'application/vnd.oada.bookmarks.1+json',
    services: {
      _type: 'application/vnd.oada.services.1+json',
      target: {
        _type: 'application/vnd.oada.service.1+json',
        jobs: {
          _type: 'application/vnd.oada.jobs.1+json',
          '*': {
            _type: 'application/vnd.oada.job.1+json',
          },
        },
        'jobs-success': {
          _type: 'application/vnd.oada.jobs.1+json',
          '*': {
            _type: 'application/vnd.oada.job.1+json',
          },
        },
        'jobs-failure': {
          _type: 'application/vnd.oada.jobs.1+json',
          '*': {
            _type: 'application/vnd.oada.job.1+json',
          },
        }
      }
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
  notversioned: true, // do not make this a versioned link in it's list
  cleanup: {
    lists: [
      `/bookmarks/services/target/jobs-success/day-index/${day}`,
      `/bookmarks/services/target/jobs-failure/day-index/${day}`,
    ]
  },
};
const items = {
  coijob: _.cloneDeep(jobtemplate),
  auditjob: _.cloneDeep(jobtemplate),
  certjob: _.cloneDeep(jobtemplate),
  logjob: _.cloneDeep(jobtemplate),

  //-------------------------------------
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


  //-------------------------------------
  // Master Data:
  tp: { 
    name: { singular: 'trading-partner' }, 
    data: {
      masterid: 'test-master-tp-1', // triggers an expand-index and masterid-index
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
      masterid: 'test-master-fac-1', // triggers an expand-index and masterid-index
      name: 'a test facility',
    },
  },
  coiholder: { 
    name: { singular: 'coi-holder' }, 
    data: {
      masterid: 'test-master-coiholder-1', // triggers an expand-index and masterid-index
      name: 'a test coi holder',
    },
  },
  logbuyer: { 
    name: { 
      singular: 'letter-of-guarantee-buyer', 
    }, 
    data: {
      masterid: 'test-master-logbuyer-1', // triggers an expand-index and masterid-index
      name: 'a test logbuyer',
    },
  },
};
// Fill out all missing things with defaults:
_.each(items, (i,k) => {
  i.key = `TEST-TARGETHELPER-${k.toUpperCase()}`;                  // default key
  if (!i.name.plural) i.name.plural = i.name.singular + 's';       // default plural
  if (!i.source) i.source = 'trellisfw';                           // default source
  if (!i.list) i.list = `/bookmarks/${i.source}/${i.name.plural}`; // default list
  if (!i.data) i.data = { iam: k };                                // default data
  if (!i._type) i._type = `application/vnd.${i.source}.${i.name.singular}.1+json`;
  if (!i.list_type) i.list_type = `application/vnd.${i.source}.${i.name.plural}.1+json`;
  // Also, fill out the tree for this list:
  if (!jp.get(tree, i.list)) {
    jp.set(tree, i.list, { _type: i.list_type });
  }
  // Add the '*' entry to the list in the tree:
  let path = `${i.list}/*`;
  if (!jp.get(tree, path)) {
    jp.set(tree, path, { _type: i._type });
  }
  if (i.data.masterid) {
    // This is masterdata, add the expand-index and masterid-index to the tree
    path = `${i.list}/expand-index`;
    if (!jp.get(tree, path)) {
      jp.set(tree, path, { _type: i.list_type });
    }
    path = `${i.list}/masterid-index`;
    if (!jp.get(tree, path)) {
      jp.set(tree, path, { _type: i.list_type });
    }
  }
});
// And finally, any inter-item relationships between master data:
items.tp.data.facilities = { [items.fac.key]: { _id: `resources/${items.fac.key}` }, };
items.coiholder.data['trading-partners'] = { [items.tp.key]: { _id: `resources/${items.tp.key}` } };
items.logbuyer.data['trading-partners'] = { [items.tp.key]: { _id: `resources/${items.tp.key}` } };


async function cleanup(key_or_keys) {
  let keys = _.keys(items);
  if (_.isArray(key_or_keys)) keys = key_or_keys;
  else if (key_or_keys) keys = [ key_or_keys ];
  info('cleanup: removing any lingering test resources');

  await Promise.each(keys, async (k) => {
    trace('cleanup: removing resources+links if they exist for key ', k);
    const i = items[k];
    let path;
    // Delete the link path from the list:
    path = `${i.list}/${i.key}`;
    await con.get({path}).then(() => con.delete({path})).catch(e=>{});
    // Delete the actual resource for this thing too:
    path = `/resources/${i.key}`;
    await con.get({path}).then(() => con.delete({path})).catch(e=>{});
    if (i.data.masterid) {
      // This is master data, so remove from masterid-index and expand-index
      path = `${i.list}/expand-index/${i.key}`;
      await con.get({path}).then(() => con.delete({path})).catch(e=>{});
      path = `${i.list}/masterid-index/${i.data.masterid}`;
      await con.get({path}).then(() => con.delete({path})).catch(e=>{});
    }
    // If there are extra lists to cleanup (like for jobs-success), do those too:
    if (i.cleanup && i.cleanup.lists) {
      await Promise.each(i.cleanup.lists, async l => {
        path = `${l}/${i.key}`;
        await con.get({path}).then(() => con.delete({path})).catch(e=>{});
      });
    }
  });
}

async function putData(key_or_keys, merges) {
  let keys = _.keys(items);
  let data_merges = [];
  if (_.isArray(key_or_keys)) {
    keys = key_or_keys;
    data_merges = merges || [];
  } else if (key_or_keys) {
    keys = [ key_or_keys ];
    data_merges = [ merges ];
  }

  await Promise.each(keys, async (k,ki) => {
    trace('putData: adding test data for key: ', k);
    const i = items[k];
    let path,data;

    // Make the resource:
    path = `/resources/${i.key}`;
    // Merge in any data overrides:
    data = i.data;
    if (data_merges[ki]) data = _.merge(data, data_merges[ki]);
    // Do the put:
    trace('putData: path: ', path, ', data = ', data);
    await con.put({ path, data, _type: i._type})
    .catch(e => { error('Failed to make the resource. path = ', path, ', data = ', i.data, ', _type = ', i._type, ', error = ', e); throw e });
    // If this has a user, go ahead and make their dummy bookmarks resource (i.e. a trading-partner)
    if (i.data.user && i.data.user.bookmarks) {
      await con.put({ 
        path: `/${i.data.user.bookmarks._id}`, 
        _type: tree.bookmarks, 
        data: { 'iam': 'userbookmarks' }
      }).catch(e => { error('Failed to make bookmarks for i.data.user. path = /', i.data.user.bookmarks._id, ', error = ', e); throw e });
    }
  });
}

async function putLink(key_or_keys) {
  let keys = _.keys(items);
  if (_.isArray(key_or_keys)) keys = key_or_keys;
  else if (key_or_keys) keys = [ key_or_keys ];

  await Promise.each(keys, async k => {
    const i = items[k];
    trace('putLink: linking test data for key: ', k, ', under list ', i.list);
    let path;

    // Link under the list:
    path = `${i.list}`;
    // NOTE: since we are doing a tree put, do NOT put the i.key on the end of the URL
    // because tree put will create a new resource instead of linking the existing one.
    let data = { [i.key]: { _id: `resources/${i.key}` } };
    if (!i.notversioned) data._rev = 0;
    await con.put({ path, data, tree })
    .catch(e => { error('Failed to link the resource. path = ', path, ', data = ', data, ', error = ', e); throw e });

    if (i.data.masterid) {
      // This is master data, so put it into the expand-index and masterid-index
      const data = _.cloneDeep(i.data);
      data.id = `resources/${i.key}`;
      // Put the expand-index:
      path = `${i.list}/expand-index`;
      await con.put({ path, data: { [i.key]: data }, tree })
      .catch(e => { error('Failed to put the expand-index.  e = ', e); throw e });

      // Put the masterid-index:
      path = `${i.list}/masterid-index`;
      await con.put({ path, data: { [i.data.masterid]: data }, tree })
      .catch(e => { error('Failed to put the masterid-index.  e = ', e); throw e });
    }
  });
}

async function putAndLinkData(key_or_keys, merges) {
  await putData(key_or_keys, merges);
  await putLink(key_or_keys);
}


function setConnection(theconnection) {
  con = theconnection;
}

module.exports = {
  tree,
  items,
  cleanup,
  putData,
  putLink,
  putAndLinkData,
  setConnection,
}
