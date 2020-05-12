import _ from 'lodash'
import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import oada from '@oada/client'
import Promise from 'bluebird'
import moment from 'moment'

import config from '../config.js'

chai.use(chaiAsPromised);
const expect = chai.expect;

let jobkey = false;
const jobpath = `/bookmarks/services/target/jobs`;
const pdfkey = 'TEST-PDF1';
const auditkey = 'TEST-FSQAAUDIT1-DUMMY';

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
  },
};

process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;
describe('success job', () => {
  let con = false;

  before(async () => {

    con = await oada.connect({ domain: config.get('domain'), token: config.get('token') });
    await con.get({ path: `/resources/${pdfkey}` })
    .catch(async e => {
      if (e && e.response && e.response.status === 404) {
        console.log('resources/TEST-PDF1 does not exist, creating a dummy one');
        await con.put({ path: `/resources/${pdfkey}`, data: {}, headers: { 'content-type': 'application/pdf' } });
      }
    });

    //--------------------------------------------------------
    // Example of a successful normal job: go ahead and put that up, tests will check results later
    jobkey = await oada.put({ path: `/resources/${jobkey}`, headers: { 'content-type': 'application/vnd.oada.job.1+json' }, data: {
      type: 'pdf',
      config: { pdf: { _id: `resources/${pdfkey}` } },
    }}).then(;
    // Link job under queue to start things off:
    await oada.put({ path: `${jobpath}/${jobkey}`, tree, data: { _id: `resources/${jobkey}` } });
    await Promise.delay(200); // wait a little bit after posting job
    // Now pretend to be target
    await oada.post({ path: `${jobpath}/${jobkey}/updates`, tree, data: {
      status: "identifying",
      time: moment().format(),
    }});
    await Promise.delay(50);
    await oada.post({ path: `${jobpath}/${jobkey}/updates`, tree, data: {
      status: "identified",
      information: 'Identified as FSQA audit',
      time: moment().format(),
    }});
    await Promise.delay(50);
    // Create the JSON resource
    await oada.put({ path: `/resources/${auditkey}`, headers: { 'content-type': 'application/vnd.trellisfw.audit.sqfi.1+json' }, data: {
      organization: {
        name: 'test audit',
      },
    }});
    // Add a lookup
    const holder = await oada.get({ path: `/bookmarks/trellisfw/coi-holders` }).then(r=>r.data[_.keys(r.data)[0]]).then(async h => await oada.get({ path: `/${h._id}` })).then(r=>r.data); // just get first coi-holder
    await oada.put({ path: `/resources/${auditkey}/_meta/lookups/fsqa-audit`, headers: { 'content-type': 'application/vnd.trellisfw.audit.sqfi.1+json' }, data: {
      organization: {
        _ref: 'resources/
      },
    }});
    // Put back result
    await con.put({ path: `${jobpath}/result`, headers: { 'content-type': 'application/vnd.oada.job.1+jso' }, data: {
      'fsqa-audits': {
        [auditkey]: { _id: `resources/${auditkey}` }
      }
    }});
    // Post success
    await con.post({ path: `${jobpath}/updates`, headers: { 'content-type': 'application/vnd.oada.job.1+json' }, data: {
      status: "success",
      type: 'fsqa-audit',
      time: moment().unix(),
    }});
    // Wait a bit for processing
    await Promise.delay(200);
  })

  // Now the real checks begin.  Did target helper:
  // 1: _ref pdf from _meta/vdoc/pdf in fsqa-audit resource
  // 2: _ref fsqa-audit from _meta/vdoc/fsqa-audits/<id> for PDF resource
  // 3: Put the FSQA audit up at /bookmarks/trellisfw/fsqa-audits/<key>
  // 4: Post update of "signing" once all is good w/target
  // 5: POST a job to trellis-signer's job queue to sign this audit (or sign it ourselves to eliminate need for trellis-signer?)
  // 6: Monitor the audit looking for signature to show up, when it appears then put "status: success" to the job (and post update)
  // 7: oada-jobs should move the job to jobs-success under today's index

  it('should _ref the PDF at _meta/vdoc/pdf in the fsqa-audit resource', async () => {
    const result = await con.get({ path: `/resources/${auditkey}/_meta/vdoc/pdf` }).then(r=>r.data);
    expect(result).to.deep.equal({ _ref: `resources/${pdfkey}` });
  });

  it('should _ref the fsqa-audit from _meta/vdoc/fsqa-audits/<id> in PDF resource', async () => {
    const result = await con.get({ path: `/resources/${pdfkey}/_meta/vdoc/fsqa-audits/${auditkey}`}).then(r=>r.data);
    expect(result).to.deep.equal({ _ref: `resources/${auditkey}` });
  });

  it('should put audit up at /bookmarks/trellisfw/fsqa-audits/<auditkey>', async () => {
    const result = await con.get({ path: `/bookmarks/trellisfw/fsqa-audits/${auditkey}` }).then(r=>r.data);
    expect(result._id).to.equal(`resources/${auditkey}`); // it exists
  });

  it('should have a signature on the audit', async () => {
    const result = await con.get({ path: `/resources/${auditkey}/signatures` }).then(r=>r.data);
    expect(result).to.be.an('array');
    expect(result.length).to.equal(1);
  });

  it('should have status of success on the job when completed', async () => {
    const result = await con.get({ path: `resources/${jobkey}/status` }).then(r=>r.data);
    expect(result).to.equal('success');
  });

  it('should delete the job from jobs', async () => {
    const result = await con.get({ path: `${jobpath}` }).catch(e => e);
    expect(_.get(result, 'response.status')).to.equal(404);
  });

  it('should put the job under today\'s day-index within jobs-success', async() => {
    const day = moment().format('YYYY-MM-DD');
    const result = await con.get({ path: `/bookmarks/services/target/jobs-success/day-index/${day}/${jobkey}` }).then(r=>r.data);
    expect(result._id).to.equal(`resources/${jobkey}`);
  });
});
