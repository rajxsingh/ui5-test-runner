class UTRError extends Error {
  get code () { return this._code }
  get details () { return this._details }

  constructor (error, details) {
    super()
    this.name = 'UTRError'
    this._code = error.code
    this.message = error.name
    this._details = details
  }
}

const errors = [{
  name: 'GENERIC'
}, {
  name: 'NPM_FAILED'
}, {
  name: 'MISSING_OR_INVALID_BROWSER_CAPABILITIES'
}, {
  name: 'BROWSER_PROBE_FAILED'
}, {
  name: 'BROWSER_FAILED'
}, {
  name: 'BROWSER_SCREENSHOT_FAILED'
}, {
  name: 'BROWSER_SCREENSHOT_TIMEOUT'
}, {
  name: 'BROWSER_SCREENSHOT_NOT_SUPPORTED'
}, {
  name: 'QUNIT_ERROR'
}]

errors.forEach((error, index) => {
  error.code = -1 - index
  UTRError[`${error.name}_CODE`] = error.code
  UTRError[error.name] = function (details = '') {
    return new UTRError(error, details)
  }
})

module.exports = {
  UTRError
}
