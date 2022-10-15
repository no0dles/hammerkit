import { TestEnvironment } from './test-environment'
import { getFileContext } from '../file/get-file-context'
import { getConsoleContextMock } from '../console/get-console-context-mock'
import { statusConsole } from '../planner/work-node-status'

export function getTestContext(cwd: string): TestEnvironment {
  const context: TestEnvironment = {
    processEnvs: { ...process.env },
    abortCtrl: new AbortController(),
    cwd,
    file: getFileContext(cwd),
    console: getConsoleContextMock(),
    status: statusConsole(),
  }
  return context
}
