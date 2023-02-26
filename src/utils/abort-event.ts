export function listenOnAbort(abort: AbortSignal, callback: () => void): { close(): void } {
  if (abort.aborted) {
    callback()
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    return { close() {} }
  }

  const eventListener = () => {
    callback()
  }
  abort.addEventListener('abort', eventListener, { once: true })

  return {
    close: () => {
      abort.removeEventListener('abort', eventListener)
    },
  }
}

export function waitOnAbort(abort: AbortSignal): Promise<void> {
  if (abort.aborted) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    listenOnAbort(abort, resolve)
  })
}
