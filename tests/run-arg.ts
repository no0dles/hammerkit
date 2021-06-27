import { RunArg } from '../src/run-arg'
import consola from 'consola'
import { join } from 'path'
import { Defer } from '../src/defer'
import { BuildFile } from '../src/parser/build-file'
import { parseBuildFile } from '../src/parser/parse-build-file'

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
      watch: false,
      cacheMethod: 'checksum',
    },
    mock,
  ]
}

export function loadExampleBuildFile(dir: string): BuildFile {
  const fileName = getBuildFilePath(dir)
  return parseBuildFile(fileName)
}

export function getBuildFilePath(dir: string): string {
  return join(__dirname, '../examples/', dir, 'build.yaml')
}

export function expectLog(mock: jest.Mock, log: string): void {
  expect(mock.mock.calls.some((c) => c[0] === log)).toBeTruthy()
}
