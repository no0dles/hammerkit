import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { getStateKey, getWorkCacheStats } from './get-work-cache-stats'
import { WorkCacheFileStats } from './work-cache-stats'
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

  it('returns a constant key for method "none" regardless of files', () => {
    expect(getStateKey(sample, 'none')).toBe(getStateKey(stats({}), 'none'))
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
})
