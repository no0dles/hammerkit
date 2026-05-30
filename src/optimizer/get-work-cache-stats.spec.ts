import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
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
    expect(Object.keys(stats.files)).toContain(join('sub', 'keep.txt'))
    expect(Object.keys(stats.files)).not.toContain(join('sub', 'skip.md'))
  })
})
