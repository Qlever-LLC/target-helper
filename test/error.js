const _ = require('lodash')
const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
const oada = require('@oada/client')
const Promise = require('bluebird')
const moment = require('moment')

chai.use(chaiAsPromised);
const expect = chai.expect;

const domain = 'proxy';
const token = 'god-proxy';

let jobkey = false;
const jobpath = `/bookmarks/services/target/jobs`;
const pdfkey = 'TEST-PDF3';
const coikey = 'TEST-COI3-DUMMY';

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

  before(async function() {
    this.timeout(10000);
    con = await oada.connect({ domain, token });

    //------------------------------------------
    // Do some cleanup: get rid of coi and pdf and /bookmarks/trellisfw/cois/${coikey}
    await Promise.each([ 
      `/resources/${pdfkey}`, `/resources/${coikey}`, `/bookmarks/trellisfw/cois/${coikey}` 
    ], path => con.get({path}).then(() => con.delete({path})).catch(e=>{}));


    //------------------------------------------
    // Create the initial PDF 
    console.log('Before 5: resources/TEST-PDF1 does not exist, creating a dummy one');
    await con.put({ path: `/resources/${pdfkey}`, data: {}, headers: { 'content-type': 'application/pdf' } });

    console.log('Before 7: posting job to get job key');
    //--------------------------------------------------------
    // Example of a successful normal job: go ahead and put that up, tests will check results later
    jobkey = await con.post({ path: `/resources`, headers: { 'content-type': 'application/vnd.oada.job.1+json' }, data: {
      service: 'target',
      type: 'pdf',
      config: { pdf: { _id: `resources/${pdfkey}` } },
    }}).then(r=>r.headers['content-location'].replace(/^\/resources\//,''));
    console.log('Before: job posted, key = ', jobkey);

    // Link job under queue to start things off:
    console.log(`Before: linking job at ${jobpath}/${jobkey}`);
    await con.put({ path: `${jobpath}/${jobkey}`, data: { _id: `resources/${jobkey}` } });
    console.log(`Before: job linked, waiting to simulate target processing`);
    await Promise.delay(200); // wait a little bit after posting job
    // Now pretend to be target
    console.log('Before: posting first target update');
    await con.post({ path: `${jobpath}/${jobkey}/updates`, data: {
      status: "identifying",
      time: moment().format(),
    }});
    await Promise.delay(50);
    console.log('Before: posting second target update');
    await con.post({ path: `${jobpath}/${jobkey}/updates`, data: {
      status: "error",
      information: 'Could not identify document',
      time: moment().format(),
    }});
    // Wait a bit for processing
    await Promise.delay(2000);
    console.log('Before: finished, running tests');
  })

  // Now the real checks begin.  Did target helper:
  // 1: _ref pdf from _meta/vdoc/pdf in coi resource
  // 2: _ref coi from _meta/vdoc/cois/<id> for PDF resource
  // 3: Put the COI up at /bookmarks/trellisfw/cois/<key>
  // 5: Sign the thing
  // 6: Monitor the coi looking for signature to show up, when it appears then put "status: success" to the job (and post update)
  // 7: oada-jobs should move the job to jobs-success under today's index

  it('should NOT _ref the PDF at _meta/vdoc/pdf in the coi resource', async () => {
    const result = await con.get({ path: `/resources/${coikey}/_meta/vdoc/pdf` }).catch(e=>e.status);
    expect(result).to.equal(403); // unauthorized on /resources that don't exist
  });

  it('should NOT _ref the coi from _meta/vdoc/cois/<id> in PDF resource', async () => {
    const result = await con.get({ path: `/resources/${pdfkey}/_meta/vdoc/cois/${coikey}`}).catch(e=>e.status);
    expect(result).to.equal(404);
  });

  it('should NOT put coi up at /bookmarks/trellisfw/cois/<coikey>', async () => {
    const result = await con.get({ path: `/bookmarks/trellisfw/cois/${coikey}` }).catch(e=>e.status);
    expect(result).to.equal(404);
  });

  it('should NOT have a signature on the coi', async () => {
    const result = await con.get({ path: `/resources/${coikey}/signatures` }).catch(e=>e.status);
    expect(result).to.equal(403); // unauthorized on /resources that don't exist
  });

  it('should have status of failure on the job when completed', async () => {
    const result = await con.get({ path: `resources/${jobkey}/status` }).then(r=>r.data);
    expect(result).to.equal('failure');
  });

  it('should delete the job from jobs', async () => {
    const result = await con.get({ path: `${jobpath}/${jobkey}` }).catch(e => e); // returns the error
    expect(result.status).to.equal(404);
  });

  it('should put the job under today\'s day-index within jobs-failure', async() => {
    const day = moment().format('YYYY-MM-DD');
    const result = await con.get({ path: `/bookmarks/services/target/jobs-failure/day-index/${day}/${jobkey}` }).then(r=>r.data);
    expect(result._id).to.equal(`resources/${jobkey}`);
  });
});
