export default {
  bookmarks: {
    _type: 'application/vnd.oada.bookmarks.1+json',
    trellisfw: {
      _type: 'application/vnd.trellisfw.1+json',
      'trading-partners': {
        _type: 'application/vnd.trellisfw.trading-partners.1+json',
        '*': {
          _type: 'application/vnd.trellisfw.trading-partner.1+json',
          bookmarks: {
            _type: 'application/vnd.oada.bookmarks.1+json',
            trellisfw: {
              _type: 'application/vnd.trellisfw.1+json',
              documents: {
                _type: 'application/vnd.trellisfw.documents.1+json',
              },
              'fsqa-audits': {
                _type: 'application/vnd.trellisfw.fsqa-audits.1+json',
                '*': {
                  _type: 'application/vnd.trellisfw.coi.1+json',
                }
              },
              'cois': {
                _type: 'application/vnd.trellisfw.cois.1+json',
                '*': {
                  _type: 'application/vnd.trellisfw.coi.1+json',
                }
              }
            }
          },
          shared: {
            _type: 'application/vnd.oada.bookmarks.1+json',
            trellisfw: {
              _type: 'application/vnd.trellisfw.1+json',
              documents: {
                _type: 'application/vnd.trellisfw.documents.1+json',
                '*': {
                  _type: 'application/vnd.trellisfw.coi.1+json',
                }
              },
              'fsqa-audits': {
                _type: 'application/vnd.trellisfw.fsqa-audits.1+json',
                '*': {
                  _type: 'application/vnd.trellisfw.coi.1+json',
                }
              },
              'cois': {
                _type: 'application/vnd.trellisfw.cois.1+json',
                '*': {
                  _type: 'application/vnd.trellisfw.coi.1+json',
                }
              }
            }
          }
        }
      },
      documents: {
        _type: 'application/vnd.trellisfw.documents.1+json',
      },
      asns: {
        _type: 'application/vnd.trellisfw.asns.1+json',
        'day-index': {
          '*': {
            _type: 'application/vnd.trellisfw.asns.1+json',
            '*': {
               _type: 'application/vnd.trellisfw.asn.sf.1+json',
            },
          },
        },
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
            _rev: 0,
          }
        }
      }
    },
  },
}
