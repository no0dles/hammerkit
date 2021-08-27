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
