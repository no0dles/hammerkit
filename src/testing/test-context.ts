import { FileContext } from '../file/file-context'
import { ConsoleContextMock } from '../console/console-context-mock'
import { Defer } from '../utils/defer'

export interface TestContext {
  processEnvs: { [key: string]: string | undefined }
  cancelDefer: Defer<void>
  cwd: string
  file: FileContext
  console: ConsoleContextMock
}
