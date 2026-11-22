import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { encodeStateEntries, getStateKey, getWorkCacheStats, stateKeyDigest } from './get-work-cache-stats'
import { WorkCacheFileStats } from './work-cache-stats'
import { combineStateKeys } from '../executer/scheduler/state-key'
import { environmentMock } from '../executer/environment-mock'

function stats(files: WorkCacheFileStats['files']): WorkCacheFileStats {
  return { created: new Date(0), files }
}

describe('getStateKey', () => {
  const sample = stats({
    'a.txt': { lastModified: 1000, checksum: 'aaa' },
    'b.txt': { lastModified: 2000, checksum: 'bbb' },
  })

  it('is deterministic for identical stats', () => {
    expect(getStateKey(sample, 'checksum')).toBe(getStateKey(sample, 'checksum'))
  })

  it('produces different keys for checksum vs modify-date', () => {
    expect(getStateKey(sample, 'checksum')).not.toBe(getStateKey(sample, 'modify-date'))
  })

  it('changes when a checksum changes (checksum method)', () => {
    const changed = stats({
      'a.txt': { lastModified: 1000, checksum: 'aaa' },
      'b.txt': { lastModified: 2000, checksum: 'CHANGED' },
    })
    expect(getStateKey(changed, 'checksum')).not.toBe(getStateKey(sample, 'checksum'))
  })

  it('changes when a modification date changes (modify-date method)', () => {
    const touched = stats({
      'a.txt': { lastModified: 1000, checksum: 'aaa' },
      'b.txt': { lastModified: 3000, checksum: 'bbb' },
    })
    expect(getStateKey(touched, 'modify-date')).not.toBe(getStateKey(sample, 'modify-date'))
  })

  it('ignores checksum changes when using modify-date', () => {
    const changed = stats({
      'a.txt': { lastModified: 1000, checksum: 'aaa' },
      'b.txt': { lastModified: 2000, checksum: 'CHANGED' },
    })
    expect(getStateKey(changed, 'modify-date')).toBe(getStateKey(sample, 'modify-date'))
  })

  it('keeps the key of a tree whose paths hold no : or , as it was, so no cache entry is missed', () => {
    expect(getStateKey(sample, 'checksum')).toBe(stateKeyDigest('a.txt:aaa,b.txt:bbb'))
    expect(getStateKey(sample, 'modify-date')).toBe(stateKeyDigest('a.txt:1000,b.txt:2000'))
  })

  it('gives a tree with a path named like a list of others a key of its own', () => {
    const two = stats({
      a: { lastModified: 1, checksum: 'aaa' },
      b: { lastModified: 1, checksum: 'bbb' },
    })
    // `a:aaa,b:bbb` as the name of one file
    const one = stats({ 'a:aaa,b': { lastModified: 1, checksum: 'bbb' } })
    expect(getStateKey(one, 'checksum')).not.toBe(getStateKey(two, 'checksum'))
    const named = stats({ 'a,b': { lastModified: 1, checksum: 'ccc' } })
    const split = stats({ a: { lastModified: 1, checksum: 'x' }, b: { lastModified: 1, checksum: 'ccc' } })
    expect(getStateKey(named, 'checksum')).not.toBe(getStateKey(split, 'checksum'))
    expect(encodeStateEntries([['a:aaa,b', 'bbb']])).not.toBe(
      encodeStateEntries([
        ['a', 'aaa'],
        ['b', 'bbb'],
      ])
    )
  })

  it('returns a constant key for method "none" regardless of files', () => {
    expect(getStateKey(sample, 'none')).toBe(getStateKey(stats({}), 'none'))
  })

  it('fits a Kubernetes label value, also when combined with the keys of dependencies', () => {
    const label = /^[a-z0-9]{1,63}$/
    expect(getStateKey(sample, 'checksum')).toMatch(label)
    expect(getStateKey(stats({}), 'checksum')).toMatch(label)
    expect(combineStateKeys(getStateKey(sample, 'checksum'), ['x', 'api=y'])).toMatch(label)
  })
})

describe('getWorkCacheStats', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hammerkit-stats-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function src(absolutePath: string, matcher: (file: string, cwd: string) => boolean = () => true) {
    return { absolutePath, source: absolutePath, matcher } as any
  }

  it('returns empty files when src has no entries', async () => {
    const env = environmentMock(dir)
    const stats = await getWorkCacheStats({ cwd: dir, src: [] } as any, env)
    expect(stats.files).toEqual({})
  })

  it('skips a src path that does not exist (early return)', async () => {
    const env = environmentMock(dir)
    const stats = await getWorkCacheStats({ cwd: dir, src: [src(join(dir, 'missing'))] } as any, env)
    expect(stats.files).toEqual({})
  })

  it('records a single file with checksum and lastModified', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello')
    const env = environmentMock(dir)
    const stats = await getWorkCacheStats({ cwd: dir, src: [src(join(dir, 'a.txt'))] } as any, env)
    expect(stats.files['a.txt']).toBeDefined()
    expect(stats.files['a.txt'].checksum).toMatch(/^[0-9a-f]+$/)
    expect(stats.files['a.txt'].lastModified).toBeGreaterThan(0)
  })

  it('walks a directory recursively and respects the matcher', async () => {
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'keep.txt'), 'k')
    writeFileSync(join(dir, 'sub', 'skip.md'), 's')
    const env = environmentMock(dir)
    const stats = await getWorkCacheStats(
      { cwd: dir, src: [src(join(dir, 'sub'), (file) => file.endsWith('.txt'))] } as any,
      env
    )
    // '/'-separated on every OS (portable cache keys)
    expect(Object.keys(stats.files)).toContain('sub/keep.txt')
    expect(Object.keys(stats.files)).not.toContain('sub/skip.md')
  })

  it('takes a link on a server as the link, and never walks where it points', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'hammerkit-stats-outside-'))
    try {
      writeFileSync(join(outside, 'secret'), 'server file')
      writeFileSync(join(dir, 'a.txt'), 'a')
      symlinkSync(outside, join(dir, 'escape'), 'junction')
      const work = { cwd: dir, src: [src(dir)] } as any
      // on a developer's machine a link is followed, as always
      expect(Object.keys((await getWorkCacheStats(work, environmentMock(dir))).files).sort()).toEqual([
        'a.txt',
        'escape/secret',
      ])
      const hosted = { ...environmentMock(dir), hosted: { catalog: { providers: {}, accounts: {} } as any } }
      const files = (await getWorkCacheStats(work, hosted)).files
      expect(Object.keys(files).sort()).toEqual(['a.txt', 'escape'])
      // where it points is part of the key
      rmSync(join(dir, 'escape'))
      symlinkSync(dir, join(dir, 'escape'), 'junction')
      expect((await getWorkCacheStats(work, hosted)).files.escape.checksum).not.toBe(files.escape.checksum)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('keys a link on a server apart from a file that holds the text it was hashed from', async () => {
    const hosted = { ...environmentMock(dir), hosted: { catalog: { providers: {}, accounts: {} } as any } }
    mkdirSync(join(dir, 'target'))
    symlinkSync(join(dir, 'target'), join(dir, 'link'), 'junction')
    // the text a link was hashed from before
    writeFileSync(join(dir, 'file'), `link:${readlinkSync(join(dir, 'link'))}`)
    const files = (await getWorkCacheStats({ cwd: dir, src: [src(dir)] } as any, hosted)).files
    expect(files.link.checksum).toMatch(/^l[0-9a-f]{64}$/)
    expect(files.file.checksum).toMatch(/^[0-9a-f]{64}$/)
    expect(files.link.checksum.slice(1)).toBe(files.file.checksum)
    expect(files.link.checksum).not.toBe(files.file.checksum)
  })

  // a run on a sandbox whose files are at `root`, with a runner
  const onSandbox = (root: string) => ({
    ...environmentMock(dir),
    hosted: {
      catalog: { providers: {}, accounts: {} } as any,
      kubernetes: { server: { workspace: { root, runner: true } } } as any,
    },
  })

  it('leaves the output of the commands of runs out of the sources of a task on a server', async () => {
    mkdirSync(join(dir, '.hammerkit', 'commands', 'a'.repeat(24)), { recursive: true })
    writeFileSync(join(dir, '.hammerkit', 'commands', 'a'.repeat(24), 'out'), 'what a command said\n')
    mkdirSync(join(dir, '.hammerkit', 'state'), { recursive: true })
    writeFileSync(join(dir, '.hammerkit', 'state', 'x'), 'x')
    writeFileSync(join(dir, 'app.ts'), 'app')
    const keyed = Object.keys((await getWorkCacheStats({ cwd: dir, src: [src(dir)] } as any, onSandbox(dir))).files)
    expect(keyed.sort()).toEqual(['.hammerkit/state/x', 'app.ts'])
    // a dev machine has no runner, nor a server without one: what is there is a source as before
    for (const environment of [
      environmentMock(dir),
      { ...environmentMock(dir), hosted: { catalog: { providers: {}, accounts: {} } as any } },
    ]) {
      const local = Object.keys((await getWorkCacheStats({ cwd: dir, src: [src(dir)] } as any, environment)).files)
      expect(local).toContain(`.hammerkit/commands/${'a'.repeat(24)}/out`)
    }
  })

  it('leaves out the commands of the sandbox at its root only, for a task in a folder of it too', async () => {
    mkdirSync(join(dir, '.hammerkit', 'commands', 'a'.repeat(24)), { recursive: true })
    writeFileSync(join(dir, '.hammerkit', 'commands', 'a'.repeat(24), 'out'), 'output')
    // a folder of the same name deeper in the files is the project's own
    mkdirSync(join(dir, 'vendor', '.hammerkit', 'commands'), { recursive: true })
    writeFileSync(join(dir, 'vendor', '.hammerkit', 'commands', 'x.js'), 'x')
    mkdirSync(join(dir, 'app', '.hammerkit', 'commands'), { recursive: true })
    writeFileSync(join(dir, 'app', '.hammerkit', 'commands', 'y.js'), 'y')
    writeFileSync(join(dir, 'app', 'main.ts'), 'main')
    if (process.platform !== 'win32') {
      // a name with a backslash is a name, not a path
      writeFileSync(join(dir, '.hammerkit\\commands'), 'z')
    }
    const keyed = Object.keys((await getWorkCacheStats({ cwd: dir, src: [src(dir)] } as any, onSandbox(dir))).files)
    expect(keyed.sort()).toEqual(
      [
        ...(process.platform !== 'win32' ? ['.hammerkit\\commands'] : []),
        'app/.hammerkit/commands/y.js',
        'app/main.ts',
        'vendor/.hammerkit/commands/x.js',
      ].sort()
    )
    // a task in a folder of the sandbox whose source is the whole of it
    const app = join(dir, 'app')
    const fromApp = Object.keys((await getWorkCacheStats({ cwd: app, src: [src(dir)] } as any, onSandbox(dir))).files)
    expect(fromApp).toContain('.hammerkit/commands/y.js')
    expect(fromApp).toContain('../vendor/.hammerkit/commands/x.js')
    expect(fromApp.some((path) => path.startsWith('../.hammerkit/commands'))).toBe(false)
  })
})
