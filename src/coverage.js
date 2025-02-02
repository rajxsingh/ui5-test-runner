'use strict'

const { join, dirname, isAbsolute } = require('path')
const { fork } = require('child_process')
const { cleanDir, createDir, filename, download, allocPromise } = require('./tools')
const { readdir, readFile, stat, writeFile, access, constants } = require('fs').promises
const { Readable } = require('stream')
const { getOutput } = require('./output')
const { resolvePackage } = require('./npm')
const { promisify } = require('util')
const { UTRError } = require('./error')
const { $remoteOnLegacy } = require('./symbols')

const $nycSettingsPath = Symbol('nycSettingsPath')
const $coverageFileIndex = Symbol('coverageFileIndex')
const $coverageRemote = Symbol('coverageRemote')

let nycInstallationPath
let nycScript

async function setupNyc (job) {
  if (!nycInstallationPath) {
    nycInstallationPath = resolvePackage(job, 'nyc')
  }
  nycScript = join(await nycInstallationPath, 'bin/nyc.js')
}

async function nyc (job, ...args) {
  const output = getOutput(job)
  output.nyc(...args)
  const childProcess = fork(nycScript, args, { stdio: 'pipe' })
  output.monitor(childProcess)
  const { promise, resolve, reject } = allocPromise()
  childProcess.on('close', async code => {
    if (code !== 0) {
      reject(UTRError.NYC_FAILED(`Return code ${code}`))
    }
    resolve()
  })
  return promise
}

const globalContextSearch = 'var global=new Function("return this")();'
const globalContextReplace = 'var global=window.top;'

const customFileSystem = {
  stat: path => stat(path)
    .then(stats => {
      stats.size -= globalContextSearch.length + globalContextReplace.length
      return stats
    }),
  readdir,
  createReadStream: async (path) => {
    const buffer = (await readFile(path))
      .toString()
      .replace(globalContextSearch, globalContextReplace)
    return Readable.from(buffer)
  }
}

async function instrument (job) {
  await setupNyc(job)
  job[$nycSettingsPath] = join(job.coverageTempDir, 'settings/nyc.json')
  await cleanDir(job.coverageTempDir)
  await createDir(join(job.coverageTempDir, 'settings'))
  const settings = JSON.parse((await readFile(job.coverageSettings)).toString())
  settings.cwd = job.cwd
  if (!settings.exclude) {
    settings.exclude = []
  }
  settings.exclude.push(join(job.coverageTempDir, '**'))
  if (job.cache) {
    settings.exclude.push(join(job.cache, '**'))
  }
  settings.exclude.push(join(job.reportDir, '**'))
  settings.exclude.push(join(job.coverageReportDir, '**'))
  await writeFile(job[$nycSettingsPath], JSON.stringify(settings))
  if (job.mode === 'url') {
    if (!job[$remoteOnLegacy]) {
      job[$coverageRemote] = true
      getOutput(job).instrumentationSkipped()
      return
    }
  }
  job.status = 'Instrumenting'
  await nyc(job, 'instrument', job.webapp, join(job.coverageTempDir, 'instrumented'), '--nycrc-path', job[$nycSettingsPath])
}

async function generateCoverageReport (job) {
  job.status = 'Generating coverage report'
  await cleanDir(job.coverageReportDir)
  const coverageMergedDir = join(job.coverageTempDir, 'merged')
  await createDir(coverageMergedDir)
  const coverageFilename = join(coverageMergedDir, 'coverage.json')
  await nyc(job, 'merge', job.coverageTempDir, coverageFilename)
  if (job[$coverageRemote] && !job.coverageProxy) {
    job.status = 'Checking remote source files'
    // Assuming all files are coming from the same server
    const { origin } = new URL(job.testPageUrls[0])
    const sourcesBasePath = join(job.coverageTempDir, 'sources')
    const coverageData = require(coverageFilename)
    const filenames = Object.keys(coverageData)
    let changes = 0
    for (const filename of filenames) {
      const fileData = coverageData[filename]
      const { path } = fileData
      if (isAbsolute(path)) {
        try {
          await access(path, constants.R_OK)
          continue
        } catch (e) {}
      }
      const filePath = join(sourcesBasePath, path)
      fileData.path = filePath
      await download(origin + path, filePath)
      ++changes
    }
    if (changes > 0) {
      await writeFile(coverageFilename, JSON.stringify(coverageData))
    }
  }
  const reporters = job.coverageReporters.map(reporter => `--reporter=${reporter}`)
  if (!job.coverageReporters.includes('text')) {
    reporters.push('--reporter=text')
  }
  const checks = []
  if (job.coverageCheckBranches || job.coverageCheckFunctions || job.coverageCheckLines || job.coverageCheckStatements) {
    if (!job.coverageReporters.includes('lcov')) {
      reporters.push('--reporter=lcov')
    }
    checks.push(
      `--branches=${job.coverageCheckBranches}`,
      `--functions=${job.coverageCheckFunctions}`,
      `--lines=${job.coverageCheckLines}`,
      `--statements=${job.coverageCheckStatements}`,
      '--check-coverage'
    )
  }
  await nyc(job, 'report', ...reporters, ...checks, '--temp-dir', coverageMergedDir, '--report-dir', job.coverageReportDir, '--nycrc-path', job[$nycSettingsPath])
  if (checks.length) {
    // The checks are not triggered if the coverage is empty
    const lcov = await stat(join(job.coverageReportDir, 'lcov.info'))
    if (lcov.size === 0) {
      throw UTRError.NYC_FAILED('No coverage information extracted')
    }
  }
}

module.exports = {
  instrument: job => job.coverage && instrument(job),
  async collect (job, url, coverageData) {
    job[$coverageFileIndex] = (job[$coverageFileIndex] || 0) + 1
    const coverageFileName = join(job.coverageTempDir, `${filename(url)}_${job[$coverageFileIndex]}.json`)
    if (job.debugCoverage) {
      getOutput(job).wrap(() => console.log('coverage', coverageFileName))
    }
    await writeFile(coverageFileName, JSON.stringify(coverageData))
  },
  generateCoverageReport: job => job.coverage ? generateCoverageReport(job) : Promise.resolve(),
  mappings: async job => {
    if (!job.coverage) {
      return []
    }
    const instrumentedBasePath = join(job.coverageTempDir, 'instrumented')
    const instrumentedMapping = {
      match: /(.*\.js)(\?.*)?$/,
      file: join(instrumentedBasePath, '$1'),
      'ignore-if-not-found': true
    }
    if (job.mode === 'legacy' || job[$remoteOnLegacy]) {
      return [{
        ...instrumentedMapping,
        'custom-file-system': job.debugCoverageNoCustomFs ? undefined : customFileSystem
      }]
    }
    if (job.mode === 'url' && job.coverageProxy) {
      await setupNyc(job)
      const { origin } = new URL(job.url[0])
      const sourcesBasePath = join(job.coverageTempDir, 'sources')
      const { createInstrumenter } = require(join(await nycInstallationPath, 'node_modules/istanbul-lib-instrument'))
      const instrumenter = createInstrumenter({
        produceSourceMap: true,
        coverageGlobalScope: 'window.top',
        coverageGlobalScopeFunc: false
      })
      const instrument = promisify(instrumenter.instrument.bind(instrumenter))
      const sources = {}
      return [{
        match: /(.*\.js)(\?.*)?$/,
        custom: async (request, response, url) => {
          if (!url.match(job.coverageProxyInclude) || url.match(job.coverageProxyExclude)) {
            if (job.debugCoverage) {
              getOutput(job).wrap(() => console.log('coverage_proxy ignore', url))
            }
            return // Ignore
          }
          const sourcePath = join(sourcesBasePath, url)
          try {
            await access(sourcePath, constants.R_OK)
          } catch (e) {
            try {
              if (sources[url]) {
                await sources[url]
              } else {
                if (job.debugCoverage) {
                  getOutput(job).wrap(() => console.log('coverage_proxy instrument', url))
                }
                sources[url] = await download(origin + url, sourcePath)
              }
            } catch (statusCode) {
              return statusCode
            }
          }
          const source = (await readFile(sourcePath)).toString()
          const instrumentedSource = await instrument(source, sourcePath)
          const instrumentedSourcePath = join(instrumentedBasePath, url)
          await createDir(dirname(instrumentedSourcePath))
          await writeFile(instrumentedSourcePath, instrumentedSource)
        }
      },
      instrumentedMapping,
      {
        match: /(.*)$/,
        url: `${origin}$1`
      }]
    }
    return []
  }
}
