export default {
  bookmarks: {
    _type: 'application/vnd.oada.bookmarks.1+json',
    trellisfw: {
      _type: 'application/vnd.trellisfw.1+json',
      documents: {
        _type: 'application/vnd.trellisfw.documents.1+json',
      },
      asns: {
        _type: 'application/vnd.trellisfw.asns.1+json',
      },
    },
    services: {
      _type: 'application/vnd.oada.services.1+json',
      '*': { // we will post to shares/jobs
        _type: 'application/vnd.oada.service.1+json',
        jobs: {
          _type: 'application/vnd.oada.service.jobs.1+json',
          '*': {
            _type: 'application/vnd.oada.service.job.1+json',
          }
        }
      }
    },
  },
}
