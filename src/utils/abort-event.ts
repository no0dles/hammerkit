export function listenOnAbort(abort: AbortSignal, callback: () => void): void {
  ;(abort as any).addEventListener(
    'abort',
    () => {
      callback()
    },
    { once: true }
  )
}
