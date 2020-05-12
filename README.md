# target-helper
A microservice to simplify Target interaction with Trellis.  Target will:
- watch a job queue, 
- receiving a job (PDF to scrape in config/pdf, ASN to read in config/asn)
- post status updates (/bookmarks/services/target/jobs/<jobid>/updates), 
- put back link to resulting scraped JSON or successful ASN processing,
- post final status update wtih status: success

`target-helper` will fill in around this
- receive the job from oada-jobs
- once it sees "success" in the updates, it will post a job to trellis-signer and notify oada-jobs of success
- if it sees "error" in the updates, it will notify oada-jobs of error
- In the caes of PDF, it will cross-link from the PDF in meta to the resulting fsqa-certificates (etc.): i.e. the
  "result" object should just go in meta/vdoc, except all id's should be ref's
- If oada-jobs doesn't have Slack posting, be sure to post to slack manually until that time


## Installation
```docker-compose
cd path/to/your/oada-srvc-docker
cd services-available
git clone git@github.com:trellisfw/trellis-signer.git
cd ../services-enabled
ln -s ../services-available/trellis-signer .
oada up -d trellis-signer
```

## Overriding defaults for Production
Using the common `z_tokens` method outlined for `oada-srvc-docker`, the following entries
for the `z_tokens` docker-compose file will work:
```docker-compose
  trellis-signer:
    volumes:
      - ./services-available/z_tokens/private_key.jwk:/private_key.jwk
    environment:
      - token=atokentouseinproduction
      - domain=your.trellis.domain
      - privateJWK=/private_key.jwk
```

Note that the `volumes` part places a production private key for signing into the container,
overriding the *completely-not-private-at-all* `private_key.jwk` that comes bundled by default.


