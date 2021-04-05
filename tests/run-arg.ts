import { RunArg } from '../src/run-arg'
import consola, { LogLevel } from 'consola'

export function getTestArg(): [RunArg, jest.Mock] {
  const mock = jest.fn()
  consola.mock(
    () =>
      function (level, message) {
        if (level && message) {
          // eslint-disable-next-line no-console
          console.log(LogLevel[level], message)
        }
        return mock(level, message)
      }
  )
  const arg = new RunArg(false, 0)
  arg.logger.level = LogLevel.Debug
  return [arg, mock]
}
