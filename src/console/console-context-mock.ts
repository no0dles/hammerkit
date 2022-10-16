import { ConsoleContext } from './console-context'

/* eslint-disable @typescript-eslint/no-empty-function */
export function consoleContextMock(): ConsoleContext {
  return {
    warn() {},
    info() {},
    error() {},
    debug() {},
  }
}
