export function checkForAbort(abortSignal: AbortSignal): void {
  if (abortSignal.aborted) {
    throw new AbortError()
  }
}

export class AbortError extends Error {}
