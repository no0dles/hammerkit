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

// An abort signal that follows `parent` and additionally fires after `timeout`
// ms, so a task deadline reuses the runtimes' existing abort/cleanup path.
export function withDeadline(parent: AbortSignal, timeout: number | null) {
  const controller = new AbortController()
  let expired = false
  const parentListener = listenOnAbort(parent, () => controller.abort())
  const timer =
    timeout === null
      ? null
      : setTimeout(() => {
          expired = true
          controller.abort()
        }, timeout)
  return {
    signal: controller.signal,
    expired: () => expired,
    clear() {
      if (timer) {
        clearTimeout(timer)
      }
      parentListener.close()
    },
  }
}
