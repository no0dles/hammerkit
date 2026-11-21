import { listenOnAbort } from '../utils/abort-event'

// How long a task may run: its own `timeout`, else the run's default (`--timeout`), and
// never longer than the run's cap (`--max-timeout`), which also covers tasks with a
// longer timeout of their own. A caller can shorten a task this way, never extend it.
export function getTaskTimeout(
  own: number | null,
  run: { timeout: number | null; maxTimeout: number | null }
): number | null {
  const timeout = own ?? run.timeout
  if (run.maxTimeout === null) {
    return timeout
  }
  return timeout === null ? run.maxTimeout : Math.min(timeout, run.maxTimeout)
}

// the longest delay of setTimeout: Node fires a longer one after 1 ms
const MAX_TIMER_MS = 2 ** 31 - 1

// An abort signal that follows `parent` and additionally fires after `timeout`
// ms, so a task deadline reuses the runtimes' existing abort/cleanup path. A
// timeout beyond what a timer can wait (about 24.8 days) sets no deadline.
// `pause` stops the clock and `resume` starts it again with what was left, so a
// wait that is not the task's to count (its pod refused by the quota) does not use it.
// The pauses together may last `timeout` as well: then it fires and `waitedOut` says so.
export function withDeadline(parent: AbortSignal, timeout: number | null) {
  const controller = new AbortController()
  const parentListener = listenOnAbort(parent, () => controller.abort())
  const limit = timeout !== null && timeout <= MAX_TIMER_MS ? timeout : null
  // what is left of the time to run, and of the time to wait in pauses
  let left = limit ?? 0
  let pauseLeft = limit ?? 0
  let paused = false
  let closed = false
  let ended: 'expired' | 'waited-out' | null = null
  let since = performance.now()
  let timer: ReturnType<typeof setTimeout> | null = null

  // ends the current stretch: what it took comes off its budget
  const stopClock = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (limit === null || ended) {
      return
    }
    const took = performance.now() - since
    if (paused) {
      pauseLeft = Math.min(limit, Math.max(0, pauseLeft - took))
    } else {
      left = Math.min(limit, Math.max(0, left - took))
    }
  }
  const startClock = () => {
    since = performance.now()
    if (limit === null || controller.signal.aborted) {
      return
    }
    const end = paused ? 'waited-out' : 'expired'
    timer = setTimeout(
      () => {
        timer = null
        ended = end
        controller.abort()
      },
      paused ? pauseLeft : left
    )
  }
  startClock()

  return {
    signal: controller.signal,
    // it ran for its timeout
    expired: () => ended === 'expired',
    // its pauses together lasted its timeout
    waitedOut: () => ended === 'waited-out',
    pause() {
      if (closed || paused || ended) {
        return
      }
      stopClock()
      paused = true
      startClock()
    },
    resume() {
      if (closed || !paused || ended) {
        return
      }
      stopClock()
      paused = false
      startClock()
    },
    clear() {
      stopClock()
      closed = true
      parentListener.close()
    },
  }
}
