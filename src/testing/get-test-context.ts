import { TestContext } from './test-context'
import { getFileContext } from '../file/get-file-context'
import { getConsoleContextMock } from '../console/get-console-context-mock'
import { Defer } from '../utils/defer'

export function getTestContext(cwd: string): TestContext {
  const context: TestContext = {
    processEnvs: { ...process.env },
    cancelDefer: new Defer<void>(),
    cwd,
    file: getFileContext(),
    console: getConsoleContextMock(),
  }
  return context
}
