import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import fc from 'fast-check'
import { minimatch } from 'minimatch'
import { stringify } from 'yaml'
import { createTestCase } from '../../testing/test-case'
import { createCli } from '../../program'
import { checkCacheState } from './enqueue-next'
import { computeStateKey } from './state-key'
import { environmentMock } from '../environment-mock'

// The cache contract, stated once: after a successful run, changing exactly one
// input a task can observe makes it a miss, and changing anything it cannot
// observe keeps it a hit. A false hit serves stale output; a false miss wastes
// the compute the cache exists to save.

// Local task execution is not reliable on the Windows hosted runner (see
// execute.spec.ts), so these real runs are gated off win32.
const itExceptWindows = process.platform === 'win32' ? it.skip : it

type BuildFile = { tasks: { [name: string]: any } }

function buildFile(): BuildFile {
  return {
    tasks: {
      lib: {
        src: ['lib/**/*.ts'],
        envs: { LIB_MODE: 'x' },
        generates: ['lib-out'],
        cmds: ['mkdir -p lib-out', 'cat lib/a.ts > lib-out/a.js'],
      },
      app: {
        description: 'the app',
        labels: { team: 'a' },
        deps: ['lib'],
        src: ['src/**/*.ts', 'package.json'],
        envs: { MODE: 'dev' },
        generates: ['dist'],
        cmds: ['mkdir -p dist', 'cat src/nested/deep/app.ts lib-out/a.js > dist/app.js'],
      },
    },
  }
}

const files = {
  '.git/HEAD': 'ref: refs/heads/main\n',
  'lib/a.ts': 'lib\n',
  'src/index.ts': 'index\n',
  'src/nested/deep/app.ts': 'app\n',
  'src/notes.md': 'notes\n',
  'package.json': '{}\n',
  'README.md': 'readme\n',
}

interface Change {
  name: string
  // edit the build file in place
  build?: (file: BuildFile) => void
  // edit the checkout
  checkout?: (cwd: string) => void
}

const observable: Change[] = [
  { name: 'a nested source file', checkout: (cwd) => writeFileSync(join(cwd, 'src/nested/deep/app.ts'), 'app v2\n') },
  { name: 'an added source file', checkout: (cwd) => writeFileSync(join(cwd, 'src/new.ts'), 'new\n') },
  { name: 'a removed source file', checkout: (cwd) => rmSync(join(cwd, 'src/index.ts')) },
  { name: 'a single-file source', checkout: (cwd) => writeFileSync(join(cwd, 'package.json'), '{"v":2}\n') },
  { name: 'the command', build: (f) => f.tasks.app.cmds.push('echo done') },
  { name: 'an env value', build: (f) => (f.tasks.app.envs.MODE = 'prod') },
  { name: 'an added env', build: (f) => (f.tasks.app.envs.EXTRA = '1') },
  { name: 'the shell', build: (f) => (f.tasks.app.shell = '/bin/bash') },
  { name: 'the generates', build: (f) => f.tasks.app.generates.push('coverage') },
  { name: 'the src declaration', build: (f) => f.tasks.app.src.push('README.md') },
  { name: 'a dependency source file', checkout: (cwd) => writeFileSync(join(cwd, 'lib/a.ts'), 'lib v2\n') },
  { name: 'a dependency command', build: (f) => f.tasks.lib.cmds.push('echo lib') },
  { name: 'a dependency env value', build: (f) => (f.tasks.lib.envs.LIB_MODE = 'y') },
  {
    name: 'an added dependency',
    build: (f) => {
      f.tasks.extra = { src: ['README.md'], cmds: ['echo extra'] }
      f.tasks.app.deps.push('extra')
    },
  },
]

const unobservable: Change[] = [
  { name: 'nothing' },
  { name: 'the description', build: (f) => (f.tasks.app.description = 'renamed') },
  { name: 'the labels', build: (f) => (f.tasks.app.labels = { team: 'b' }) },
  { name: 'the timeout', build: (f) => (f.tasks.app.timeout = '10m') },
  { name: 'a file outside src', checkout: (cwd) => writeFileSync(join(cwd, 'README.md'), 'readme v2\n') },
  {
    name: 'a non-matching file inside a src directory',
    checkout: (cwd) => writeFileSync(join(cwd, 'src/notes.md'), 'notes v2\n'),
  },
  {
    name: 'only the mtime of a source file',
    checkout: (cwd) => utimesSync(join(cwd, 'src/index.ts'), new Date(2001, 1, 1), new Date(2001, 1, 1)),
  },
]

async function cachedAfter(change: Change, testName: string): Promise<boolean> {
  let cached = false
  const file = buildFile()
  await createTestCase(testName, { ...files, '.hammerkit.yaml': file }).setup(async (cwd, environment) => {
    const first = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'app' })
    await first.clean({ cache: true })
    expect((await first.runExec()).success).toBe(true)

    if (change.build) {
      change.build(file)
      writeFileSync(join(cwd, '.hammerkit.yaml'), stringify(file))
    }
    change.checkout?.(cwd)

    const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'app' })
    cached = (await checkCacheState(cli.task('app'), 'checksum', environment)).cached
  })
  return cached
}

const slug = (name: string) => name.replace(/[^a-z0-9]+/gi, '-')

describe('cache invariants', () => {
  describe.each(observable)('changing $name', (change) => {
    itExceptWindows('is a cache miss', async () => {
      expect(await cachedAfter(change, `invariant-miss-${slug(change.name)}`)).toBe(false)
    })
  })

  describe.each(unobservable)('changing $name', (change) => {
    itExceptWindows('stays a cache hit', async () => {
      expect(await cachedAfter(change, `invariant-hit-${slug(change.name)}`)).toBe(true)
    })
  })
})

// Which files a src entry makes inputs, for random trees and every glob form
// FR-010 promises. The expected set is computed per file, independent of the
// directory walk that has to find them.
describe('cache invariants: src matching', () => {
  const dirs = ['src', 'lib', 'a', 'b', '.cfg']
  const names = ['x', 'y', 'app', 'a']
  const exts = ['ts', 'js', 'md']

  const dir = fc.array(fc.constantFrom(...dirs), { minLength: 1, maxLength: 2 }).map((d) => d.join('/'))
  const ext = fc.constantFrom(...exts)
  const tree = fc.uniqueArray(
    fc
      .tuple(fc.array(fc.constantFrom(...dirs), { maxLength: 3 }), fc.constantFrom(...names), ext)
      .map(([path, name, e]) => [...path, `${name}.${e}`].join('/')),
    { minLength: 1, maxLength: 25 }
  )

  type Source = { src: string; matches: (file: string) => boolean }
  const glob = (src: string): Source => ({ src, matches: (file) => minimatch(file, src, { dot: true }) })
  const source: fc.Arbitrary<Source> = fc.oneof(
    ext.map((e) => glob(`**/*.${e}`)),
    fc.tuple(dir, ext).map(([d, e]) => glob(`${d}/**/*.${e}`)),
    fc.tuple(dir, ext).map(([d, e]) => glob(`${d}/*.${e}`)),
    dir.map((d) => glob(`${d}/**`)),
    ext.map((e) => glob(`*/*.${e}`)),
    fc.tuple(dir, dir, ext).map(([d1, d2, e]) => glob(`{${d1},${d2}}/**/*.${e}`)),
    fc.tuple(dir, ext).map(([d, e]) => glob(`${d}/?.${e}`)),
    fc.tuple(dir, ext).map(([d, e]) => glob(`${d}/[ax]*.${e}`)),
    fc.tuple(dir, ext).map(([d, e]) => glob(`${d}/@(x|app).${e}`)),
    dir.map((d) => ({ src: d, matches: (file: string) => file.startsWith(`${d}/`) })),
    fc
      .tuple(dir, fc.constantFrom(...names), ext)
      .map(([d, n, e]) => ({ src: `${d}/${n}.${e}`, matches: (file: string) => file === `${d}/${n}.${e}` }))
  )

  it('hashes exactly the files a src entry matches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hammerkit-src-matching-'))
    try {
      let run = 0
      await fc.assert(
        fc.asyncProperty(tree, source, async (files, { src, matches }) => {
          const cwd = join(root, `${run++}`)
          for (const file of files) {
            mkdirSync(dirname(join(cwd, file)), { recursive: true })
            writeFileSync(join(cwd, file), file)
          }
          writeFileSync(join(cwd, '.hammerkit.yaml'), stringify({ tasks: { t: { src: [src], cmds: ['echo'] } } }))

          const environment = environmentMock(cwd)
          const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 't' })
          const { stats } = await computeStateKey(cli.task('t'), 'checksum', environment)

          expect(Object.keys(stats.files).sort()).toEqual(files.filter(matches).sort())
        }),
        { numRuns: 200 }
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
