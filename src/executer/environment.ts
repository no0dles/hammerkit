import { FileContext } from '../file/file-context'
import { ConsoleContext } from '../console/console-context'

export interface Environment {
  processEnvs: { [key: string]: string | undefined }
  cancelDefer: AbortController
  cwd: string
  file: FileContext
  console: ConsoleContext
}
