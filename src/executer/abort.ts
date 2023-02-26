import { waitOnAbort } from '../utils/abort-event'

export function checkForAbort(abortSignal: AbortSignal): void {
  if (abortSignal.aborted) {
    throw new AbortError()
  }
}

export function createSubController(abort: AbortSignal): AbortController {
  const abortController = new AbortController()
  waitOnAbort(abort).then(() => {
    abortController.abort()
  })
  return abortController
}

export class AbortError extends Error {}
