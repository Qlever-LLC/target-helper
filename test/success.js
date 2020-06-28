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
const pdfkey = 'TEST-PDF2';
const coikey = 'TEST-COI1-DUMMY';

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
      status: "identified",
      information: 'Identified as COI',
      time: moment().format(),
    }});
    await Promise.delay(50);
    // Create the JSON resource
    console.log('Before: Put-ing JSON COI resource')
    await con.get({ path: `/resources/${coikey}` })
    .then(async () => {
      await con.delete({ path: `/resources/${coikey}` }); // clean copy each time
    }).catch(e => {}) // doesn't exist, go ahead and create
    await con.put({ path: `/resources/${coikey}`, headers: { 'content-type': 'application/vnd.trellis.coi.1+json' }, data: {
      holder: {
        name: 'test holder',
      },
    }});
    // Add a lookup: default to the first holder in the list of holders
    console.log('Before: Put-ing holder');
    const holder = await con.get({ path: `/bookmarks/trellisfw/coi-holders` })
                         .then(r=>r.data[_.filter(_.keys(r.data),k=>!k.match(/^_/))[0]])
                         .then(h => { console.log('Retrieving holder ',h); return h })
                         .then(async h => 
                           await con.get({ path: `/${h._id}` })
                         ).then(r=>r.data); // just get first coi-holder
    await con.put({ path: `/resources/${coikey}/_meta/lookups/coi`, data: {
      holder: {
        _ref: `${holder._id}`,
      },
    }});
    console.log('Before: putting result');
    // Put back result
    await con.put({ path: `${jobpath}/${jobkey}/result`, data: {
      'cois': { [coikey]: { _id: `resources/${coikey}` } }
    }});
    // Post success
    console.log('Before: posting result');
    await con.post({ path: `${jobpath}/${jobkey}/updates`, data: {
      status: "success",
      type: 'coi',
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

  it('should _ref the job under pdf/_meta/services/target/jobs', async () => {
    const result = await con.get({ path: `/resources/${pdfkey}/_meta/services/target/jobs/${jobkey}`}).then(r=>r.data);
    expect(result._ref).to.equal(`resources/${jobkey}`);
  });

  it('should _ref the PDF at _meta/vdoc/pdf in the coi resource', async () => {
    const result = await con.get({ path: `/resources/${coikey}/_meta/vdoc/pdf` }).then(r=>r.data);
    expect(result).to.deep.equal({ _ref: `resources/${pdfkey}` });
  });

  it('should _ref the coi from _meta/vdoc/cois/<id> in PDF resource', async () => {
    const result = await con.get({ path: `/resources/${pdfkey}/_meta/vdoc/cois/${coikey}`}).then(r=>r.data);
    expect(result).to.deep.equal({ _ref: `resources/${coikey}` });
  });

  it('should put coi up at /bookmarks/trellisfw/cois/<coikey>', async () => {
    const result = await con.get({ path: `/bookmarks/trellisfw/cois/${coikey}` }).then(r=>r.data);
    expect(result._id).to.equal(`resources/${coikey}`); // it exists
  });

  it('should have a signature on the coi', async () => {
    const result = await con.get({ path: `/resources/${coikey}/signatures` }).then(r=>r.data);
    expect(result).to.be.an('array');
    expect(result.length).to.equal(1);
  });

  it('should have status of success on the job when completed', async () => {
    const result = await con.get({ path: `resources/${jobkey}/status` }).then(r=>r.data);
    expect(result).to.equal('success');
  });

  it('should delete the job from jobs', async () => {
    const result = await con.get({ path: `${jobpath}/${jobkey}` }).catch(e => e); // returns the error
    expect(result.status).to.equal(404);
  });

  it('should put the job under today\'s day-index within jobs-success', async() => {
    const day = moment().format('YYYY-MM-DD');
    const result = await con.get({ path: `/bookmarks/services/target/jobs-success/day-index/${day}/${jobkey}` }).then(r=>r.data);
    expect(result._id).to.equal(`resources/${jobkey}`);
  });
});
