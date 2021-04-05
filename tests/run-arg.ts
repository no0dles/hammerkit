import { RunArg } from '../src/run-arg'
import consola, { LogLevel } from 'consola'

export function getTestArg(): [RunArg, jest.Mock] {
  const mock = jest.fn()
  consola.mock(
    () =>
      function (level, message) {
        if (level && message) {
          console.log(LogLevel[level], message)
        }
        return mock(...arguments)
      }
  )
  const arg = new RunArg(false, 0)
  arg.logger.level = LogLevel.Debug
  return [arg, mock]
}
