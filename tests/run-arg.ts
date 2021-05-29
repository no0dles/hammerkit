import { RunArg } from '../src/run-arg'
import consola from 'consola'
import { join } from 'path'
import { ExecutionBuildFile, parse } from '../src/rewrite/0-parse'
import { Defer } from '../src/defer'

export function getTestArg(): [RunArg, jest.Mock] {
  const mock = jest.fn()
  consola.mock(
    () =>
      function (level, message) {
        if (level && message) {
          // eslint-disable-next-line no-console
          // console.log(LogLevel[level], message)
        }
        return mock(level, message)
      }
  )
  return [
    {
      workers: 0,
      processEnvs: { ...process.env },
      logger: consola,
      cancelPromise: new Defer<void>(),
      noContainer: false,
    },
    mock,
  ]
}

export function loadExampleBuildFile(dir: string): ExecutionBuildFile {
  const fileName = getBuildFilePath(dir)
  return parse(fileName)
}

export function getBuildFilePath(dir: string): string {
  return join(__dirname, '../examples/', dir, 'build.yaml')
}

export function expectLog(mock: jest.Mock, log: string): void {
  expect(mock.mock.calls.some((c) => c[0] === log)).toBeTruthy()
}
