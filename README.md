# target-helper

<!--
[![License](https://img.shields.io/github/license/Qlever-LLC/target-helper)](LICENSE)
[![Docker Pulls](https://img.shields.io/docker/pulls/Qlever-LLC/target-helper)][dockerhub]
-->

A microservice to simplify Target interaction with Trellis. Target will:

- watch a job queue,
- receiving a job (PDF to scrape in config/pdf, ASN to read in config/asn)
- post status updates (/bookmarks/services/target/jobs/<jobid>/updates),
- put back link to resulting scraped JSON or successful ASN processing,
- post final status update wtih status: success

`target-helper` will fill in around this

```shell
NODE_TLS_REJECT_UNAUTHORIZED=0
PDF_TIMEOUT= # timeout on pdf jobs
CONCURRENCY= # oada client request concurrency
JOB_CONCURRENCY= # number of jobs to run concurrently
DEBUG=
notifyurl= #slack url for notifications
ENABLE_TRADING_PARTNERS= # watch trading partners docs endpoints
PINO_LEVEL=
PROM_PORT=
DOMAIN=
TOKEN=
```

### Running Qlever-LLC/target-helper within the [OADA Reference API Server]

To add this service to the services run with an OADA v3 server,
simply add a snippet like the one in the previous section
to your `docker-compose.override.yml`.


###Jobs

The service provides the following job handlers:

### `transcription-only`

```javascript
const job = {
  "service": "target-helper",
  "type": "transcription-only",
  "config": {
    type: 'pdf';
    pdf: {
      _id: string;
    };
    sign?: boolean; // whether to sign the resulting document
    useRefs?: boolean; //whether to rewrite links in the pdf/_meta as _refs instead of true links
  }
}

let jobResult = await doJob(job);
let { result } = jobResult;
/*
  {
    "cois": { // keys corresponding to each doc type
      "abc123": {
        "_id": "resources/abc123" //links to each json result
      },
      ...
    },
    ...
  }
*/
let { target } = jobResult;
/*
  targetResult === result for jobs of type transcription-only
*/
```

### `transcription`
Sorry about the poor naming; this should eventually be deprecated and renamed...
This job type is intended for specific workflows utilizing the startJobCreator in src/pdfJob to create jobs when
docs show up in the trading-partner's or smithfield's `/bookmarks/services/trellisfw/documents` endpoints.
Under this workflow, documents may have some initial content and suspected document type, and the `targetResult`
is merged in with the original json content. Additionally, signing, vdoc references, and other post-processes are mandatory.

```javascript
const job = {
  "service": "target-helper",
  "type": "transcription",
  "config": {
    type: 'pdf';
    pdf: {
      _id: string;
    };
    sign?: boolean; // whether to sign the resulting document
    useRefs?: boolean; //whether to rewrite links in the pdf/_meta as _refs instead of true links
  }
}

let jobResult = await doJob(job);
let { result } = jobResult;
/*
  {
    "cois": { // keys corresponding to each doc type
      "abc123": {
        "_id": "resources/abc123" //
      },
      ...
    },
    ...
  }
*/
```
