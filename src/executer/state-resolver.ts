import { State } from './state'
import { listenOnAbort } from '../utils/abort-event'
import { AbortError } from './abort'

export function untilChanged<T>(key: string, state: State<T>, abort: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = state.on(key, (value) => {
      handle.close()
      abortListener.close()
      resolve(value)
    })
    const abortListener = listenOnAbort(abort, () => {
      handle.close()
      reject(new AbortError())
    })
  })
}

export function isState<T, R extends T>(
  key: string,
  state: State<T>,
  condition: (state: T) => state is R,
  abort: AbortSignal
): Promise<R> {
  if (condition(state.current)) {
    return Promise.resolve(state.current)
  }

  return new Promise<R>((resolve, reject) => {
    const listener = state.on(key, (value) => {
      if (!condition(value)) {
        return
      }

      abortListener.close()
      resolve(value)
      listener.close()
    })

    const abortListener = listenOnAbort(abort, () => {
      listener.close()
      reject(new AbortError())
    })
  })
}

export function awaitState<T>(
  key: string,
  state: State<T>,
  condition: (state: T) => boolean,
  abort: AbortSignal
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (condition(state.current)) {
      resolve()
      return
    }

    const listener = state.on(key, (value) => {
      if (!condition(value)) {
        return
      }

      listener.close()
      abortListener.close()
      resolve()
    })
    const abortListener = listenOnAbort(abort, () => {
      listener.close()
      reject(new AbortError())
    })
  })
}
