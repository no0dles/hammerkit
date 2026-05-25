#!/usr/bin/env node
/*
 * Build a single coverage report that merges the unit suite with the
 * docker/kubernetes integration suite, excluding test-related code.
 *
 * The unit run (jest.config.ts) cannot exercise the docker/kubernetes/service
 * runtime, so on its own it badly understates coverage for those modules. This
 * script runs the unit suite for lcov, then merges it with the integration
 * lcov, and renders one istanbul HTML report under coverage-merged/.
 *
 * Usage:
 *   npm run coverage:merged
 *
 * Inputs (lcov):
 *   coverage/lcov.info               generated here by the unit run
 *   coverage-integration/lcov.info   provide one of:
 *     - locally:  npm run test:integration   (needs Docker + a cluster), or
 *     - from CI:  download the `integration-coverage-*` artifact of a green
 *                 integration run into coverage-integration/lcov.info, e.g.
 *                   gh run download <run-id> --dir coverage-integration
 *   If the integration lcov is missing the report is still produced from the
 *   unit run alone (with a warning), so docker/kubernetes will read low.
 *
 * Output: coverage-merged/index.html plus a per-module line-coverage summary.
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const libCoverage = require('istanbul-lib-coverage')
const libReport = require('istanbul-lib-report')
const reports = require('istanbul-reports')

const repoRoot = path.resolve(__dirname, '..')
const unitLcov = path.join(repoRoot, 'coverage', 'lcov.info')
const integrationLcov = path.join(repoRoot, 'coverage-integration', 'lcov.info')
const outDir = path.join(repoRoot, 'coverage-merged')

const isTestFile = (p) => p.includes('src/testing/') || p.endsWith('.spec.ts') || p.endsWith('.d.ts')

function runUnitCoverage() {
  console.log('> running unit suite for lcov (excluding test code)...')
  execFileSync(
    process.execPath,
    [
      require.resolve('jest/bin/jest'),
      '--coverage',
      '--coverageReporters=lcov',
      '--collectCoverageFrom=src/**/*.ts',
      '--collectCoverageFrom=!src/testing/**',
      '--collectCoverageFrom=!**/*.spec.ts',
      '--collectCoverageFrom=!**/*.d.ts',
    ],
    { cwd: repoRoot, stdio: 'inherit', env: { ...process.env, CI: 'true' } }
  )
}

// parse an lcov file into { [relPath]: { da, fnLine, fnda, brda } }
function parseLcov(file) {
  const out = {}
  let cur = null
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('SF:')) {
      const p = line.slice(3)
      cur = out[p] || (out[p] = { da: new Map(), fnLine: new Map(), fnda: new Map(), brda: new Map() })
    } else if (!cur) {
      continue
    } else if (line.startsWith('DA:')) {
      const [ln, hits] = line.slice(3).split(',')
      cur.da.set(+ln, (cur.da.get(+ln) || 0) + (+hits || 0))
    } else if (line.startsWith('FN:')) {
      const i = line.indexOf(',')
      cur.fnLine.set(line.slice(i + 1), +line.slice(3, i))
    } else if (line.startsWith('FNDA:')) {
      const i = line.indexOf(',')
      const name = line.slice(i + 1)
      cur.fnda.set(name, (cur.fnda.get(name) || 0) + (+line.slice(5, i) || 0))
    } else if (line.startsWith('BRDA:')) {
      const [ln, block, branch, taken] = line.slice(5).split(',')
      const key = `${ln}:${block}:${branch}`
      cur.brda.set(key, (cur.brda.get(key) || 0) + (taken === '-' ? 0 : +taken || 0))
    }
  }
  return out
}

// merge any number of parsed lcov maps (summing hits), dropping test files
function mergeAll(maps) {
  const out = {}
  for (const src of maps) {
    for (const [p, f] of Object.entries(src)) {
      if (isTestFile(p)) continue
      const t = out[p] || (out[p] = { da: new Map(), fnLine: new Map(), fnda: new Map(), brda: new Map() })
      for (const [k, v] of f.da) t.da.set(k, (t.da.get(k) || 0) + v)
      for (const [k, v] of f.fnLine) t.fnLine.set(k, v)
      for (const [k, v] of f.fnda) t.fnda.set(k, (t.fnda.get(k) || 0) + v)
      for (const [k, v] of f.brda) t.brda.set(k, (t.brda.get(k) || 0) + v)
    }
  }
  return out
}

// turn a merged lcov file-struct into an istanbul coverage-data object.
// lcov is line-based, so statements are modelled one-per-covered-line.
function toIstanbul(relPath, f) {
  const abs = path.resolve(repoRoot, relPath)
  const statementMap = {}
  const s = {}
  const fnMap = {}
  const fn = {}
  const branchMap = {}
  const b = {}
  let i = 0
  for (const [ln, hits] of [...f.da.entries()].sort((x, y) => x[0] - y[0])) {
    statementMap[i] = { start: { line: ln, column: 0 }, end: { line: ln, column: 0 } }
    s[i] = hits
    i++
  }
  let fi = 0
  for (const [name, ln] of f.fnLine) {
    const loc = { start: { line: ln, column: 0 }, end: { line: ln, column: 0 } }
    fnMap[fi] = { name, decl: loc, loc, line: ln }
    fn[fi] = f.fnda.get(name) || 0
    fi++
  }
  const groups = new Map()
  for (const [key, hits] of f.brda) {
    const [ln, block] = key.split(':')
    const g = `${ln}:${block}`
    if (!groups.has(g)) groups.set(g, { line: +ln, hits: [] })
    groups.get(g).hits.push(hits)
  }
  let bi = 0
  for (const { line, hits } of groups.values()) {
    const loc = { start: { line, column: 0 }, end: { line, column: 0 } }
    branchMap[bi] = { loc, type: 'branch', line, locations: hits.map(() => loc) }
    b[bi] = hits
    bi++
  }
  return { path: abs, statementMap, fnMap, branchMap, s, f: fn, b }
}

function main() {
  runUnitCoverage()

  const sources = []
  if (fs.existsSync(unitLcov)) {
    sources.push(parseLcov(unitLcov))
  } else {
    console.error(`! missing ${path.relative(repoRoot, unitLcov)} — unit run produced no lcov`)
    process.exit(1)
  }
  if (fs.existsSync(integrationLcov)) {
    sources.push(parseLcov(integrationLcov))
    console.log('> merging integration coverage from coverage-integration/lcov.info')
  } else {
    console.warn(
      '! coverage-integration/lcov.info not found — reporting unit coverage only.\n' +
        '  docker/kubernetes will read low. See the header of this script for how to obtain it.'
    )
  }

  const merged = mergeAll(sources)
  const data = {}
  for (const [relPath, f] of Object.entries(merged)) {
    const ist = toIstanbul(relPath, f)
    data[ist.path] = ist
  }

  const map = libCoverage.createCoverageMap(data)
  const context = libReport.createContext({ dir: outDir, coverageMap: map })
  reports.create('html', { skipEmpty: false }).execute(context)
  reports.create('text-summary').execute(context)

  const agg = {}
  let tc = 0
  let tt = 0
  for (const file of map.files()) {
    const sum = map.fileCoverageFor(file).toSummary().lines
    const rel = file.slice(file.indexOf('/src/') + 5)
    const mod = rel.includes('/') ? rel.split('/')[0] : '(src root)'
    const a = agg[mod] || (agg[mod] = { c: 0, t: 0 })
    a.c += sum.covered
    a.t += sum.total
    tc += sum.covered
    tt += sum.total
  }
  console.log('\n=== merged coverage per module (lines) ===')
  for (const [m, a] of Object.entries(agg).sort((x, y) => y[1].c / y[1].t - x[1].c / x[1].t)) {
    console.log(m.padEnd(16), ((100 * a.c) / a.t).toFixed(1).padStart(7) + '%', ' ' + a.c + '/' + a.t)
  }
  console.log('-'.repeat(40))
  console.log('TOTAL'.padEnd(16), ((100 * tc) / tt).toFixed(1).padStart(7) + '%', ' ' + tc + '/' + tt)
  console.log(`\nHTML report: ${path.relative(repoRoot, outDir)}/index.html`)
}

main()
