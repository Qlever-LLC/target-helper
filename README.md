# target-helper

[![License](https://img.shields.io/github/license/Qlever-LLC/target-helper)](LICENSE)
[![Docker Pulls](https://img.shields.io/docker/pulls/Qlever-LLC/target-helper)][dockerhub]

A microservice to simplify Target interaction with Trellis. Target will:

- watch a job queue,
- receiving a job (PDF to scrape in config/pdf, ASN to read in config/asn)
- post status updates (/bookmarks/services/target/jobs/<jobid>/updates),
- put back link to resulting scraped JSON or successful ASN processing,
- post final status update wtih status: success

`target-helper` will fill in around this

- receive the job from oada-jobs
- once it sees "success" in the updates, it will post a job to target-helper and notify oada-jobs of success
- if it sees "error" in the updates, it will notify oada-jobs of error
- In the caes of PDF, it will cross-link from the PDF in meta to the resulting fsqa-certificates (etc.): i.e. the
  "result" object should just go in meta/vdoc, except all id's should be ref's
- If oada-jobs doesn't have Slack posting, be sure to post to slack manually until that time

## Usage

Docker images for Qlever-LLC/target-helper are available from GitHub Container Registry.

### docker-compose

Here is an example of using this service with docker-compose.

```yaml
services:
  service:
    image: Qlever-LLC/target-helper
    restart: unless-stopped
    environment:
      NODE_TLS_REJECT_UNAUTHORIZED:
      NODE_ENV=: ${NODE_ENV:-development}
      DEBUG: ${DEBUG-*:error,*:warn,*:info}
      # Connect to host if DOMAIN not set.
      # You should really not rely on this though. Set DOMAIN.
      DOMAIN: ${DOMAIN:-host.docker.internal}
      # Unless your API server is running with development tokens enabled,
      # you will need to give the service token(s) to use.
      TOKEN: ${TOKEN:-abc123,def456}
```

### Running Qlever-LLC/target-helper within the [OADA Reference API Server]

To add this service to the services run with an OADA v3 server,
simply add a snippet like the one in the previous section
to your `docker-compose.override.yml`.
