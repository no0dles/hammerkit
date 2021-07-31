import { FileContext } from '../file/file-context'
import { ConsoleContext } from '../console/console-context'
import { Defer } from '../utils/defer'

export interface Environment {
  processEnvs: { [key: string]: string | undefined }
  cancelDefer: Defer<void>
  cwd: string
  file: FileContext
  console: ConsoleContext
}
