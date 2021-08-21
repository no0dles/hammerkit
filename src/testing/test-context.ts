import { FileContext } from '../file/file-context'
import { ConsoleContextMock } from '../console/console-context-mock'

export interface TestContext {
  processEnvs: { [key: string]: string | undefined }
  abortCtrl: AbortController
  cwd: string
  file: FileContext
  console: ConsoleContextMock
}
