import { RunArg } from '../src/run-arg'
import consola, { LogLevel } from 'consola'
import { join } from 'path'
import { parseBuildFile } from '../src/parse'
import { ParsedBuildFile } from '../src/parsedBuildFile'

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

export function loadExampleBuildFile(dir: string): ParsedBuildFile {
  const fileName = join(__dirname, '../examples/', dir, 'build.yaml')
  return parseBuildFile(fileName, null)
}

export function expectLog(mock: jest.Mock, log: string) {
  expect(mock.mock.calls.some(c => c[0] === log)).toBeTruthy()
}
