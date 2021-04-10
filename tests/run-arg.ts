import { RunArg } from '../src/run-arg'
import consola, { LogLevel } from 'consola'
import { join } from 'path'
import { parseBuildFile } from '../src/parse'
import { ParsedBuildFile } from '../src/parsedBuildFile'
import { readFileSync } from 'fs'

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
  const fileName = getBuildFilePath(dir)
  return parseBuildFile(fileName, null)
}

export function getBuildFileContent(dir: string): Buffer {
  const fileName = getBuildFilePath(dir)
  return readFileSync(fileName)
}

export function getBuildFilePath(dir: string): string {
  return join(__dirname, '../examples/', dir, 'build.yaml')
}

export function expectLog(mock: jest.Mock, log: string): void {
  expect(mock.mock.calls.some((c) => c[0] === log)).toBeTruthy()
}
