import { ConsoleContext } from './console-context'

export function consoleContextMock(): ConsoleContext {
  return {
    warn(message: string) {},
    info(message: string) {},
    error(message: string) {},
    debug(message: string) {},
  }
}
