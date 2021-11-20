import { TestEnvironment } from './test-environment'
import { getFileContext } from '../file/get-file-context'
import { getConsoleContextMock } from '../console/get-console-context-mock'

export function getTestContext(cwd: string): TestEnvironment {
  const context: TestEnvironment = {
    processEnvs: { ...process.env },
    abortCtrl: new AbortController(),
    cwd,
    file: getFileContext(),
    console: getConsoleContextMock(),
  }
  return context
}
