const { join } = require('path')
const { mock } = require('reserve')
const jobFactory = require('./job')
const reserveConfigurationFactory = require('./reserve')
const { mock: mockChildProcess } = require('child_process')
const { execute } = require('./tests')
const nock = require('nock')
const { readFile, stat, writeFile } = require('fs').promises
const { cleanDir, createDir } = require('./tools')
const { UTRError } = require('./error')
const { $browsers } = require('./symbols')

describe('simulate', () => {
  const simulatePath = join(__dirname, '../tmp/simulate')
  const cwd = join(__dirname, '../test/project')

  let job
  let mocked
  let pages = {}

  beforeAll(() => {
    const nockScope = nock('https://ui5.sap.com/').persist()
    const nockContent = [
      '/resources/sap-ui-core.js',
      '/resources/sap/ui/qunit/qunit-redirect.js',
      '/resources/sap/ui/thirdparty/qunit.js',
      '/resources/sap/ui/thirdparty/qunit-2.js'
    ]
    nockContent.forEach(url => {
      nockScope.get(url).reply(200, `/* ${url} */`)
    })
    nockScope.get('/resources/not-found.js').reply(404)
    nockScope.get('/resources/error.js').reply(500)
    return cleanDir(simulatePath)
  })

  async function get (url, referer) {
    return await mocked.request('GET', url, { 'x-page-url': referer })
  }

  async function post (url, referer, body) {
    const json = JSON.stringify(body)
    return await mocked.request('POST', url, {
      'x-page-url': referer,
      'content-type': 'application/json',
      'content-length': json.length
    }, json)
  }

  async function simulateOK (referer, __coverage__ = undefined) {
    await post('/_/QUnit/begin', referer, { totalTests: 1, modules: [{ tests: [{ testId: '1' }] }] })
    await post('/_/QUnit/testDone', referer, { testId: '1', failed: 0, passed: 1 })
    await post('/_/QUnit/done', referer, { failed: 0, __coverage__ })
  }

  async function setup (name, ...args) {
    mockChildProcess({
      api: 'fork',
      scriptPath: /puppeteer\.js$/,
      exec: async childProcess => {
        const config = JSON.parse((await readFile(childProcess.args[0])).toString())
        const { capabilities, url: referer } = config
        if (capabilities) {
          await writeFile(capabilities, JSON.stringify({
            console: true,
            scripts: true
          }))
          childProcess.close()
        } else {
          childProcess.on('message.received', message => {
            if (message.command === 'stop') {
              childProcess.close()
            }
          })
          const pageName = Object.keys(pages).filter(page => referer.endsWith(page))[0]
          if (pageName) {
            await pages[pageName](referer)
          } else {
            console.warn(`Page ${referer} not found`)
            expect(false).toStrictEqual(true)
          }
        }
      },
      close: false
    })

    mockChildProcess({
      api: 'fork',
      scriptPath: /\breport\.js$/,
      exec: async childProcess => {
        const reportDir = childProcess.args[0]
        await writeFile(join(reportDir, 'report.html'), '<html />')
      }
    })

    job = jobFactory.fromObject(cwd, {
      reportDir: join(simulatePath, name, 'report'),
      coverageTempDir: join(simulatePath, name, 'coverage/temp'),
      coverageReportDir: join(simulatePath, name, 'coverage/report'),
      ...args
    })
    const configuration = await reserveConfigurationFactory(job)
    mocked = await mock(configuration)
  }

  async function safeExecute () {
    try {
      await execute(job)
    } catch (e) {
      if (e instanceof UTRError && e.code === UTRError.BROWSER_FAILED_CODE) {
        const exception = Object.keys(job[$browsers])
          .map(url => job[$browsers][url].childProcess && job[$browsers][url].childProcess.exception)
          .filter(e => !!e)[0]
        throw exception
      }
      throw e
    }
  }

  describe('legacy (local project)', () => {
    describe('simple test execution', () => {
      beforeAll(async () => {
        await setup('simple')
        pages = {
          'testsuite.qunit.html': async referer => {
            const response = await get('/resources/sap/ui/qunit/qunit-redirect.js', referer)
            expect(response.statusCode).toStrictEqual(200)
            expect(response.toString().includes('qunit-redirect.js */')).toStrictEqual(false)
            expect(response.toString().includes('addTestPages')).toStrictEqual(true)
            await post('/_/addTestPages', referer, [
              referer.replace('testsuite.qunit.html', 'page1.html'),
              referer.replace('testsuite.qunit.html', 'page2.html')
            ])
          },
          'page1.html': async referer => {
            const response = await get('/resources/sap/ui/thirdparty/qunit.js', referer)
            expect(response.statusCode).toStrictEqual(200)
            expect(response.toString().includes('qunit.js */')).toStrictEqual(true)
            expect(response.toString().includes('QUnit/begin')).toStrictEqual(true)
            simulateOK(referer, {})
          },
          'page2.html': async referer => {
            const response = await get('/resources/sap/ui/thirdparty/qunit-2.js', referer)
            expect(response.statusCode).toStrictEqual(200)
            expect(response.toString().includes('qunit-2.js */')).toStrictEqual(true)
            expect(response.toString().includes('QUnit/begin')).toStrictEqual(true)
            simulateOK(referer)
          }
        }
        await safeExecute()
      })

      it('succeeded', () => {
        expect(job.failed).toStrictEqual(0)
      })

      it('provides a progress endpoint', async () => {
        const response = await mocked.request('GET', '/_/progress')
        expect(response.statusCode).toStrictEqual(200)
        const progress = JSON.parse(response.toString())
        expect(Object.keys(progress.qunitPages).length).toStrictEqual(2)

        const page1 = Object.keys(progress.qunitPages).filter(url => url.endsWith('page1.html'))
        expect(page1).not.toBeUndefined()
        const qunitPage1 = progress.qunitPages[page1]
        expect(qunitPage1).not.toStrictEqual(undefined)
        expect(qunitPage1.failed).toStrictEqual(0)
        expect(qunitPage1.passed).toStrictEqual(1)
        expect(qunitPage1.report).not.toStrictEqual(undefined)

        const page2 = Object.keys(progress.qunitPages).filter(url => url.endsWith('page2.html'))
        expect(page2).not.toBeUndefined()
        const qunitPage2 = progress.qunitPages[page2]
        expect(qunitPage2).not.toStrictEqual(undefined)
      })

      it('generates a report', async () => {
        const info = await stat(join(job.reportDir, 'report.html'))
        expect(info.isFile()).toStrictEqual(true)
        expect(info.size).toBeGreaterThan(0)
      })
    })

    describe('error (test fail)', () => {
      beforeAll(async () => {
        await setup('error')
        pages = {
          'testsuite.qunit.html': async referer => {
            await post('/_/addTestPages', referer, [
              '/page1.html',
              '/page2.html'
            ])
          },
          'page1.html': referer => simulateOK(referer),
          'page2.html': async referer => {
            await post('/_/QUnit/begin', referer, { totalTests: 1, modules: [{ tests: [{ testId: '1' }] }] })
            await post('/_/QUnit/testDone', referer, { testId: '1', failed: 1, passed: 0 })
            await post('/_/QUnit/done', referer, { failed: 1 })
          }
        }
        await safeExecute()
      })

      it('failed', () => {
        expect(job.failed).toStrictEqual(1)
      })
    })
  })

  //   describe('error (invalid QUnit hooks)', () => {
  //     jest.setTimeout(500000)
  //     beforeAll(async () => {
  //       await setup('error')
  //       pages = {
  //         'testsuite.qunit.html': async headers => {
  //           await mocked.request('POST', '/_/addTestPages', headers, JSON.stringify([
  //             '/page1.html',
  //             '/page2.html'
  //           ]))
  //         },
  //         'page1.html': async headers => {
  //           simulateOK(headers)
  //         },
  //         'page2.html': async headers => {
  //           // The next call will dump an error because the missing /_/QUnit/begin call generates the page structure
  //           await mocked.request('POST', '/_/QUnit/testDone', headers, JSON.stringify({ failed: 1, passed: 0 }))
  //           await mocked.request('POST', '/_/QUnit/done', headers, JSON.stringify({ failed: 1 }))
  //         }
  //       }
  //       await execute(job)
  //     })

  //     it('failed', () => {
  //       expect(job.failed).toStrictEqual(1)
  //     })
  //   })

  //   describe('global timeout', () => {
  //     beforeAll(async () => {
  //       await setup('timeout', {
  //         parallel: 1,
  //         globalTimeout: 10000
  //       })
  //       pages = {
  //         'testsuite.qunit.html': async headers => {
  //           await mocked.request('POST', '/_/addTestPages', headers, JSON.stringify([
  //             '/page1.html',
  //             '/page2.html'
  //           ]))
  //         },
  //         'page1.html': async headers => {
  //           job.globalTimeout = 1 // Update to ensure the code will globally time out *after* page1
  //           simulateOK(headers)
  //         },
  //         'page2.html': async headers => {
  //           expect(false).toStrictEqual(true) // Should not be executed
  //         }
  //       }
  //       await execute(job)
  //     })

  //     it('failed', () => {
  //       expect(job.failed).not.toStrictEqual(0)
  //     })
  //   })

  //   describe('coverage substitution and ui5 cache', () => {
  //     let ui5Cache

  //     beforeAll(async () => {
  //       await setup('coverage_and_cache', {
  //         cache: 'ui5'
  //       })
  //       ui5Cache = join(__dirname, '../../tmp/simulate/coverage_and_cache/ui5')
  //       await cleanDir(ui5Cache)
  //       pages = {
  //         'testsuite.qunit.html': async headers => {
  //           const instrumentedPath = join(__dirname, '../../tmp/simulate/coverage_and_cache/coverage/temp/instrumented')
  //           await createDir(instrumentedPath)
  //           const instrumentedComponentPath = join(instrumentedPath, 'component.js')
  //           await writeFile(instrumentedComponentPath, `/* component.js */
  // var global=new Function("return this")();
  // // code from component.js
  // `)
  //           const cachedResponses = await Promise.all([
  //             mocked.request('GET', '/resources/sap-ui-core.js', headers),
  //             mocked.request('GET', '/resources/sap-ui-core.js', headers)
  //           ])
  //           expect(cachedResponses[0].statusCode).toStrictEqual(200)
  //           expect(cachedResponses[0].toString().includes('sap-ui-core.js */')).toStrictEqual(true)
  //           const notFoundResponse = await mocked.request('GET', '/resources/not-found.js', headers)
  //           expect(notFoundResponse.statusCode).toStrictEqual(404)
  //           const errorResponse = await mocked.request('GET', '/resources/error.js', headers)
  //           expect(errorResponse.statusCode).toStrictEqual(500)
  //           await mocked.request('POST', '/_/addTestPages', headers, JSON.stringify([
  //             '/page1.html',
  //             '/page2.html'
  //           ]))
  //         },
  //         'page1.html': async headers => {
  //           const coverageResponse = await mocked.request('GET', '/component.js', headers)
  //           expect(coverageResponse.statusCode).toStrictEqual(200)
  //           expect(coverageResponse.toString().includes('component.js */')).toStrictEqual(true)
  //           expect(coverageResponse.toString().includes('var global=new Function("return this")();')).toStrictEqual(false)
  //           expect(coverageResponse.toString().includes('var global=window.top;')).toStrictEqual(true)
  //           const cachedResponse = await mocked.request('GET', '/resources/sap/ui/thirdparty/qunit.js', headers)
  //           expect(cachedResponse.statusCode).toStrictEqual(200)
  //           expect(cachedResponse.toString().includes('qunit.js */')).toStrictEqual(true)
  //           expect(cachedResponse.toString().includes('QUnit/begin')).toStrictEqual(true)
  //           simulateOK(headers)
  //         },
  //         'page2.html': async headers => {
  //           const cachedResponse = await mocked.request('GET', '/resources/not-found.js', headers)
  //           expect(cachedResponse.statusCode).toStrictEqual(404)
  //           simulateOK(headers)
  //         }
  //       }
  //       await execute(job)
  //     })

  //     it('succeeded', () => {
  //       expect(job.failed).toStrictEqual(0)
  //     })
  //   })

  //   describe('error and failFast (stop after first failure)', () => {
  //     beforeAll(async () => {
  //       await setup('fail_fast', {
  //         parallel: 1,
  //         failFast: null
  //       })
  //       pages = {
  //         'testsuite.qunit.html': async headers => {
  //           await mocked.request('POST', '/_/addTestPages', headers, JSON.stringify([
  //             '/page1.html',
  //             '/page2.html',
  //             '/page3.html',
  //             '/page4.html'
  //           ]))
  //         },
  //         'page1.html': async headers => {
  //           simulateOK(headers)
  //         },
  //         'page2.html': async headers => {
  //           await mocked.request('POST', '/_/QUnit/begin', headers, JSON.stringify({ totalTests: 1 }))
  //           await mocked.request('POST', '/_/QUnit/testDone', headers, JSON.stringify({ failed: 1, passed: 0 }))
  //           await mocked.request('POST', '/_/QUnit/done', headers, JSON.stringify({ failed: 1 }))
  //         }
  //         // Should not try to run page 3 & 4
  //       }
  //       await execute(job)
  //     })

  //     it('failed', () => {
  //       expect(job.failed).toStrictEqual(3) // page2 + other pages that didn't run
  //     })
  //   })

  //   describe('error when no page found', () => {
  //     beforeAll(async () => {
  //       await setup('no_page', {
  //         parallel: 1
  //       })
  //       pages = {
  //         'testsuite.qunit.html': async headers => {
  //           await mocked.request('POST', '/_/addTestPages', headers, JSON.stringify([]))
  //         }
  //       }
  //       await execute(job)
  //     })

  //     it('failed', () => {
  //       expect(job.failed).toStrictEqual(true) // page2 + other pages that didn't run
  //     })
  //   })

  //   describe('ui5 libraries', () => {
  //     beforeAll(async () => {
  //       await setup('ui5', {
  //         ui5: 'https://any.cdn.com/',
  //         libs: [join(__dirname, '../..'), `inject/=${join(__dirname, '../../src/inject')}`]
  //       })
  //       pages = {
  //         'testsuite.qunit.html': async headers => {
  //           await mocked.request('POST', '/_/addTestPages', headers, JSON.stringify([
  //             '/page1.html'
  //           ]))
  //         },
  //         'page1.html': async headers => {
  //           const response1 = await mocked.request('GET', '/resources/inject/qunit-hooks.js', headers)
  //           expect(response1.statusCode).toStrictEqual(200)
  //           expect(response1.toString().includes('/* Injected QUnit hooks */')).toStrictEqual(true)
  //           const response2 = await mocked.request('GET', '/resources/src/inject/qunit-hooks.js', headers)
  //           expect(response2.statusCode).toStrictEqual(200)
  //           expect(response2.toString().includes('/* Injected QUnit hooks */')).toStrictEqual(true)
  //           simulateOK(headers)
  //         }
  //       }
  //       await execute(job)
  //     })

//     it('succeeded', () => {
//       expect(job.failed).toStrictEqual(0)
//     })
//   })
})
