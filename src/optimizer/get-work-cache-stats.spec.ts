import { getStateKey } from './get-work-cache-stats'
import { WorkCacheFileStats } from './work-cache-stats'

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
