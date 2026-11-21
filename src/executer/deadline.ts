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
export function withDeadline(parent: AbortSignal, timeout: number | null) {
  const controller = new AbortController()
  let expired = false
  const parentListener = listenOnAbort(parent, () => controller.abort())
  const limited = timeout !== null && timeout <= MAX_TIMER_MS
  let left = timeout ?? 0
  let since = Date.now()
  let timer: ReturnType<typeof setTimeout> | null = null
  const start = () => {
    since = Date.now()
    timer = setTimeout(() => {
      expired = true
      controller.abort()
    }, left)
  }
  const stop = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
      left = Math.max(0, left - (Date.now() - since))
    }
  }
  if (limited) {
    start()
  }
  return {
    signal: controller.signal,
    expired: () => expired,
    pause() {
      stop()
    },
    resume() {
      if (limited && !timer && !expired && !controller.signal.aborted) {
        start()
      }
    },
    clear() {
      stop()
      parentListener.close()
    },
  }
}
