import { FileContext } from '../file/file-context'
import { ConsoleContextMock } from '../console/console-context-mock'
import { StatusConsole } from '../planner/work-node-status'

export interface TestEnvironment {
  processEnvs: { [key: string]: string | undefined }
  abortCtrl: AbortController
  cwd: string
  file: FileContext
  console: ConsoleContextMock // TODO remove/combine with status
  status: StatusConsole
}
