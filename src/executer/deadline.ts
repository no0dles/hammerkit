import { listenOnAbort } from '../utils/abort-event'

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
