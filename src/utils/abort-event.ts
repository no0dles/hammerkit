export function listenOnAbort(abort: AbortSignal, callback: () => void): void {
  if (abort.aborted) {
    callback()
    return
  }

  const listener = abort as any
  listener.addEventListener(
    'abort',
    () => {
      callback()
    },
    { once: true }
  )
}

export function waitOnAbort(abort: AbortSignal): Promise<void> {
  if (abort.aborted) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    listenOnAbort(abort, resolve)
  })
}
