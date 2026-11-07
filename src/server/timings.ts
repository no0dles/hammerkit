import type { TaskStatus } from './runs'

/**
 * How long runs waited and ran, and what the past runs of a task took: for the dashboard,
 * `remote runs`, `remote tasks` and GET /v1/tasks. Only the times of a run are used, never
 * its output, so anybody who may see a run may see them.
 */
export interface Timed {
  state: string
  createdAt: string
  queuedAt?: string
  startedAt?: string
  finishedAt?: string
}

const at = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN)

// How long a run waited in the queue for a place: from when it was queued (after its
// approval, or when it woke) until it started, or until now while it waits.
export function waitedMs(run: Timed, now: number): number | undefined {
  const queued = at(run.queuedAt)
  if (!Number.isFinite(queued)) {
    return undefined
  }
  const started = at(run.startedAt)
  if (Number.isFinite(started) && started >= queued) {
    return started - queued
  }
  if (run.state === 'queued') {
    return Math.max(0, now - queued)
  }
  // it ended before it started: cancelled in the queue
  const finished = at(run.finishedAt)
  return Number.isFinite(finished) && finished >= queued ? finished - queued : undefined
}

// How long a run ran: from its start to its end, or until now while it runs. A service run
// counts until its services were up.
export function ranMs(run: Timed & { upAt?: string }, now: number): number | undefined {
  const started = at(run.startedAt)
  if (!Number.isFinite(started)) {
    return undefined
  }
  const up = at(run.upAt)
  const finished = at(run.finishedAt)
  const end = Number.isFinite(up) && up >= started ? up : Number.isFinite(finished) ? finished : now
  return Math.max(0, end - started)
}

// a span of time as a person reads it at a glance: 2d 3h, 7h 59m, 29m 5s, 12s, 340ms
export function roughly(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`
  }
  const seconds = Math.round(ms / 1000)
  const [d, h, m, s] = [
    Math.floor(seconds / 86400),
    Math.floor(seconds / 3600) % 24,
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
  if (d > 0) {
    return `${d}d ${h}h`
  }
  if (h > 0) {
    return `${h}h ${m}m`
  }
  if (m > 0) {
    return s > 0 && m < 10 ? `${m}m ${s}s` : `${m}m`
  }
  return `${s}s`
}

export interface TaskTimingLike {
  status: TaskStatus
  durationMs?: number
  finishedAt?: string
}

export interface RunTimings extends Timed {
  source: { type: string; repo?: string }
  timings?: Record<string, TaskTimingLike>
}

// What the past runs of one task of a repository took, over the runs the server keeps.
export interface TaskStats {
  repo: string
  task: string
  // runs in which it ran or was taken from the cache
  runs: number
  succeeded: number
  failed: number
  cached: number
  last: { status: TaskStatus; at: string; durationMs?: number }
  // of the runs that executed it (not from the cache), in ms
  medianMs?: number
  p90Ms?: number
  // how long those runs waited for a place, median, in ms
  medianWaitMs?: number
}

function quantile(sorted: number[], q: number): number | undefined {
  if (sorted.length === 0) {
    return undefined
  }
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]
}

/**
 * Per task and repository, newest first: how often it ran and how, what it took the last
 * time, and the median and 90th percentile of the times it executed. `runs` is newest first.
 */
export function getTaskStats(runs: RunTimings[], now: number): TaskStats[] {
  const groups = new Map<string, { stats: TaskStats; durations: number[]; waits: number[] }>()
  for (const run of runs) {
    const repo = run.source.repo ?? 'an upload'
    const waited = waitedMs(run, now)
    for (const [task, timing] of Object.entries(run.timings ?? {})) {
      if (timing.status === 'running' || timing.status === 'skipped' || timing.status === 'cancelled') {
        continue
      }
      const key = `${repo}\0${task}`
      let group = groups.get(key)
      if (!group) {
        group = {
          stats: {
            repo,
            task,
            runs: 0,
            succeeded: 0,
            failed: 0,
            cached: 0,
            last: {
              status: timing.status,
              at: timing.finishedAt ?? run.finishedAt ?? run.createdAt,
              ...(timing.durationMs !== undefined ? { durationMs: timing.durationMs } : {}),
            },
          },
          durations: [],
          waits: [],
        }
        groups.set(key, group)
      }
      const { stats } = group
      stats.runs++
      if (timing.status === 'cached') {
        stats.cached++
        continue
      }
      timing.status === 'succeeded' ? stats.succeeded++ : stats.failed++
      if (timing.durationMs !== undefined) {
        group.durations.push(timing.durationMs)
      }
      if (waited !== undefined) {
        group.waits.push(waited)
      }
    }
  }
  return [...groups.values()].map(({ stats, durations, waits }) => {
    durations.sort((a, b) => a - b)
    waits.sort((a, b) => a - b)
    const median = quantile(durations, 0.5)
    const p90 = quantile(durations, 0.9)
    const wait = quantile(waits, 0.5)
    return {
      ...stats,
      ...(median !== undefined ? { medianMs: median } : {}),
      ...(p90 !== undefined ? { p90Ms: p90 } : {}),
      ...(wait !== undefined ? { medianWaitMs: wait } : {}),
    }
  })
}
