import _ from 'lodash';
import oada from '@oada/client';
import Promise from 'bluebird';

import config from '../config.js';

(async () => {
  const jobpath = `/bookmarks/services/target/jobs`;
  const pdfkey = 'TEST-PDF1';
  const auditkey = 'TEST-FSQAAUDIT1-DUMMY';

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
          'jobs-error': {
            '_type': 'application/vnd.oada.jobs.1+json',
            '*': {
              _type: 'application/vnd.oada.job.1+json',
            },
          },
        },
      },
    },
  };

  process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;
  let domain = config.get('domain');
  if (domain.match(/^http/)) domain = domain.replace(/^https:\/\//, '');
  const con = await oada.connect({ domain, token: config.get('token') });
  await con.get({ path: `/resources/${pdfkey}` }).catch(async (e) => {
    if (e && e.status === 404) {
      console.log('resources/TEST-PDF1 does not exist, creating a dummy one');
      await con.put({
        path: `/resources/${pdfkey}`,
        data: {},
        headers: { 'content-type': 'application/pdf' },
      });
    }
  });

  //--------------------------------------------------------
  // Example of a successful normal job: go ahead and put that up, tests will check results later
  const jobkey = await con
    .post({
      path: `/resources`,
      headers: { 'content-type': 'application/vnd.oada.job.1+json' },
      data: {
        type: 'pdf',
        config: {
          pdf: { _id: `resources/${pdfkey}` },
        },
      },
    })
    .then((r) => r.headers['content-location'].replace(/^\/resources\//, ''));

  // Link job under queue to start things off:
  console.log('Creating job key: ', jobkey);
  await con.put({
    path: `${jobpath}`,
    headers: { 'content-type': 'application/vnd.oada.jobs.1+json' },
    data: {
      [jobkey]: { _id: `resources/${jobkey}` },
    },
  });

  process.exit(0);
})();
