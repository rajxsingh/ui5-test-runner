'use strict'

const { screenshot, stop } = require('./browsers')
const { collect } = require('./coverage')
const { UTRError } = require('./error')
const { getOutput } = require('./output')
const { basename } = require('path')
const { filename, stripUrlHash } = require('./tools')

function error (job, url, details = '') {
  stop(job, url)
  job.failed = true
  throw UTRError.QUNIT_ERROR(details)
}

function invalidTestId (job, url, testId) {
  error(job, url, `No QUnit unit test found with id ${testId}`)
}

function get (job, urlWithHash, testId) {
  const url = stripUrlHash(urlWithHash)
  const page = job.qunitPages && job.qunitPages[url]
  if (!page) {
    error(job, url, `No QUnit page found for ${urlWithHash}`)
  }
  let testModule
  let test
  if (testId !== undefined) {
    page.modules.every(module => {
      test = module.tests.find(test => test.testId === testId)
      if (test === undefined) {
        return true
      } else {
        testModule = module
        return false
      }
    })
    if (!test && job.qunitStrict) {
      invalidTestId(job, url, testId)
    }
  }
  return { url, page, testModule, test }
}

async function done (job, urlWithHash, report) {
  const { url, page } = get(job, urlWithHash)
  if (page.earlyStart && page.count === 0) {
    return // wait
  }
  if (job.browserCapabilities.screenshot) {
    try {
      await screenshot(job, url, 'done')
    } catch (error) {
      getOutput(job).genericError(error, url)
    }
  }
  page.end = new Date()
  if (report.__coverage__) {
    await collect(job, url, report.__coverage__)
    delete report.__coverage__
  }
  page.report = report
  stop(job, url)
}

module.exports = {
  get,

  async begin (job, urlWithHash, { isOpa, totalTests, modules }) {
    const url = stripUrlHash(urlWithHash)
    const earlyStart = !totalTests || !modules
    if (earlyStart) {
      getOutput(job).qunitEarlyStart(url)
      if (job.qunitStrict) {
        error(job, url, 'Invalid begin hook details')
      }
    }
    if (!job.qunitPages) {
      job.qunitPages = {}
    }
    const qunitPage = {
      id: filename(url),
      start: new Date(),
      isOpa: !!isOpa,
      failed: 0,
      passed: 0,
      count: totalTests,
      modules
    }
    if (earlyStart) {
      qunitPage.earlyStart = true
    }
    job.qunitPages[url] = qunitPage
  },

  async testStart (job, urlWithHash, { module, name, testId }) {
    let { page, testModule, test } = get(job, urlWithHash, testId)
    if (!testModule) {
      testModule = { name: module, tests: [] }
      page.modules.push(testModule)
    }
    if (!test) {
      test = { name, testId }
      testModule.tests.push(test)
      ++page.count
    }
    test.start = new Date()
  },

  async log (job, urlWithHash, { module, name, testId, ...log }) {
    const { url, page, test } = get(job, urlWithHash, testId)
    if (!test) {
      invalidTestId(job, url, testId)
    }
    if (!test.logs) {
      test.logs = []
    }
    test.logs.push(log)
    if (page.isOpa && job.browserCapabilities.screenshot && job.screenshot) {
      try {
        const absoluteName = await screenshot(job, url, `${testId}-${log.runtime}`)
        log.screenshot = basename(absoluteName)
      } catch (error) {
        getOutput(job).genericError(error, url)
      }
    }
  },

  async testDone (job, urlWithHash, { name, module, testId, assertions, ...report }) {
    const { failed } = report
    const { url, page, test } = get(job, urlWithHash, testId)
    if (!test) {
      invalidTestId(job, url, testId)
    }
    if (failed) {
      if (job.browserCapabilities.screenshot) {
        try {
          const absoluteName = await screenshot(job, url, testId)
          test.screenshot = basename(absoluteName)
        } catch (error) {
          getOutput(job).genericError(error, url)
        }
      }
      ++page.failed
      job.failed = true
    } else {
      ++page.passed
    }
    test.end = new Date()
    test.report = report
    if (job.failOpaFast && failed) {
      // skip remaining tests
      page.modules.forEach(module => {
        module.tests.forEach(test => {
          if (!test.report) {
            test.skip = true
          }
        })
      })
      await done(job, urlWithHash, {
        failed: page.failed,
        passed: page.passed,
        total: page.count,
        runtime: 0
      })
    }
  },

  done
}
