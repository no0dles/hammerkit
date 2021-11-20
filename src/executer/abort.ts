export function checkForAbort(abortSignal: AbortSignal) {
  if (abortSignal.aborted) {
    throw new AbortError()
  }
}

export class AbortError extends Error {}
