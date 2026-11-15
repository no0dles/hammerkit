import { getTaskStats, ranMs, roughly, waitedMs } from './timings'

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 7, 9, minutes)).toISOString()
const now = Date.parse(at(30))

describe('timings', () => {
  it('counts the wait from when a run was queued, and the run until it ended or was up', () => {
    expect(waitedMs({ state: 'succeeded', createdAt: at(0), queuedAt: at(2), startedAt: at(5) }, now)).toBe(3 * 60000)
    expect(waitedMs({ state: 'queued', createdAt: at(0), queuedAt: at(20) }, now)).toBe(10 * 60000)
    // cancelled in the queue
    expect(waitedMs({ state: 'cancelled', createdAt: at(0), queuedAt: at(1), finishedAt: at(4) }, now)).toBe(3 * 60000)
    // before queuedAt was kept, or while it waits for an approval
    expect(waitedMs({ state: 'awaiting-approval', createdAt: at(0) }, now)).toBeUndefined()
    expect(ranMs({ state: 'running', createdAt: at(0), startedAt: at(10) }, now)).toBe(20 * 60000)
    expect(ranMs({ state: 'failed', createdAt: at(0), startedAt: at(10), finishedAt: at(11) }, now)).toBe(60000)
    expect(ranMs({ state: 'up', createdAt: at(0), startedAt: at(10), upAt: at(12) }, now)).toBe(2 * 60000)
    expect(roughly(340)).toBe('340ms')
    expect(roughly(12_000)).toBe('12s')
    expect(roughly(5 * 60_000 + 3000)).toBe('5m 3s')
    expect(roughly(29 * 60_000 + 3000)).toBe('29m')
    expect(roughly(8 * 3600_000 - 1000)).toBe('7h 59m')
    expect(roughly(50 * 3600_000)).toBe('2d 2h')
  })

  it('sums up the past runs of each task of a repository', () => {
    const run = (minutes: number, status: string, durationMs?: number, repo = 'github.com/corp/shop') => ({
      state: status === 'failed' ? 'failed' : 'succeeded',
      createdAt: at(minutes),
      queuedAt: at(minutes),
      startedAt: at(minutes + 1),
      finishedAt: at(minutes + 2),
      source: { type: 'ref', repo },
      // a new version of the build file from minute 15 on
      definition: minutes >= 15 ? 'sha256:new' : 'sha256:old',
      timings: { test: { status: status as 'succeeded', durationMs, finishedAt: at(minutes + 2) } },
    })
    const stats = getTaskStats(
      [
        run(20, 'succeeded', 3000),
        run(15, 'cached'),
        run(10, 'failed', 1000),
        run(5, 'succeeded', 2000),
        run(1, 'succeeded', 9000, 'github.com/corp/other'),
      ],
      now
    )
    expect(stats).toEqual([
      {
        repo: 'github.com/corp/shop',
        task: 'test',
        runs: 4,
        succeeded: 2,
        failed: 1,
        cached: 1,
        last: { status: 'succeeded', at: at(22), durationMs: 3000, definition: 'sha256:new' },
        medianMs: 2000,
        p90Ms: 3000,
        totalMs: 6000,
        medianWaitMs: 60000,
      },
      {
        repo: 'github.com/corp/other',
        task: 'test',
        runs: 1,
        succeeded: 1,
        failed: 0,
        cached: 0,
        last: { status: 'succeeded', at: at(3), durationMs: 9000, definition: 'sha256:old' },
        medianMs: 9000,
        p90Ms: 9000,
        totalMs: 9000,
        medianWaitMs: 60000,
      },
    ])
  })
})
