import { CacheEntry } from './cache-backend'
import { planRetention } from './retention'

const DAY = 86_400_000
const now = 100 * DAY

function entry(taskId: string, stateKey: string, ageDays: number, size: number | null = 100): CacheEntry {
  return { taskId, stateKey, size, createdAt: now - ageDays * DAY, lastAccessedAt: null }
}

const keys = (entries: CacheEntry[]) => entries.map((e) => `${e.taskId}/${e.stateKey}`).sort()

describe('planRetention', () => {
  it('keeps the newest versions per task with keepPerTask', () => {
    const plan = planRetention(
      [entry('a', '1', 3), entry('a', '2', 1), entry('a', '3', 2), entry('b', '1', 5)],
      { keepPerTask: 1 },
      now
    )
    expect(keys(plan.keep)).toEqual(['a/2', 'b/1'])
    expect(keys(plan.evict)).toEqual(['a/1', 'a/3'])
  })

  it('evicts entries not used within maxAge, using the last-access marker when present', () => {
    const recentlyUsed = { ...entry('a', 'old-but-used', 40), lastAccessedAt: now - 2 * DAY }
    const plan = planRetention(
      [entry('a', 'stale', 40), recentlyUsed, entry('b', 'fresh', 10)],
      { maxAge: 30 * DAY },
      now
    )
    expect(keys(plan.evict)).toEqual(['a/stale'])
  })

  it('evicts least recently used entries until the total is under maxSize', () => {
    const plan = planRetention(
      [entry('a', '1', 1, 400), entry('b', '1', 3, 400), entry('c', '1', 2, 400)],
      { maxSize: 900 },
      now
    )
    expect(keys(plan.evict)).toEqual(['b/1'])
    expect(plan.keep.reduce((sum, e) => sum + (e.size ?? 0), 0)).toBeLessThanOrEqual(900)
  })

  it('combines policies: keepPerTask, then maxAge, then maxSize', () => {
    const plan = planRetention(
      [entry('a', '1', 1, 500), entry('a', '2', 2, 500), entry('b', '1', 50, 500), entry('c', '1', 3, 500)],
      { keepPerTask: 1, maxAge: 30 * DAY, maxSize: 600 },
      now
    )
    expect(keys(plan.keep)).toEqual(['a/1'])
    expect(keys(plan.evict)).toEqual(['a/2', 'b/1', 'c/1'])
  })

  it('reports a policy it cannot apply instead of ignoring it', () => {
    const plan = planRetention(
      [entry('a', '1', 0.1, null), { ...entry('b', '1', 1), createdAt: null }],
      { maxSize: 10, maxAge: DAY / 2 },
      now
    )
    expect(plan.unavailable).toEqual([
      'max-age: 1 entry has no timestamp and was kept',
      'max-size: the backend cannot report the size of 1 entry',
    ])
    expect(plan.evict).toEqual([])
  })

  it('keeps everything without a policy', () => {
    const plan = planRetention([entry('a', '1', 999)], {}, now)
    expect(plan.evict).toEqual([])
  })
})
