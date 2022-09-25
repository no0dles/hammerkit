export function listenOnAbort(abort: AbortSignal, callback: () => void): void {
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
  return new Promise<void>((resolve) => {
    listenOnAbort(abort, resolve)
  })
}
