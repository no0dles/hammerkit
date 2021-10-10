import { listenOnAbort } from './abort-event'
import { ConsoleContext } from '../console/console-context'
import { getErrorMessage } from '../log'

export interface AbortableFunctionContext {
  addAbortFunction(cleanupFn: AbortFunction): void

  checkForAbort(): void
  isAborted(): boolean
}

export type AbortFunction = () => void | Promise<void>

export function abortableFunction<T>(
  console: ConsoleContext,
  abortSignal: AbortSignal | AbortSignal[],
  fn: (ctx: AbortableFunctionContext) => Promise<T>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanupFunctions: AbortFunction[] = []
    let aborted = false

    function doAbort(err: Error) {
      aborted = true
      Promise.allSettled(cleanupFunctions.map((fn) => fn())).then((results) => {
        for (const result of results) {
          if (result.status === 'rejected') {
            console.error(getErrorMessage(result.reason))
          }
        }
        reject(err)
      })
    }

    if (abortSignal instanceof Array) {
      for (const signal of abortSignal) {
        listenOnAbort(signal, () => {
          doAbort(new Error('canceled'))
        })
      }
    } else {
      listenOnAbort(abortSignal, () => {
        doAbort(new Error('canceled'))
      })
    }

    const isAborted = (): boolean => {
      if (abortSignal instanceof Array) {
        for (const signal of abortSignal) {
          if (signal.aborted) {
            return true
          }
        }
        return false
      } else {
        return abortSignal.aborted
      }
    }

    fn({
      addAbortFunction(cleanupFn: AbortFunction) {
        if (aborted) {
          cleanupFn()
        } else {
          cleanupFunctions.push(cleanupFn)
        }
      },
      isAborted,
      checkForAbort() {
        if (isAborted()) {
          throw new Error('canceled')
        }
      },
    })
      .then((result) => {
        resolve(result)
      })
      .catch((err) => {
        doAbort(err)
      })
  })
}
