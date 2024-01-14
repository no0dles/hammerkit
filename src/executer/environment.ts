import { FileContext } from '../file/file-context'
import { ConsoleContext } from '../console/console-context'
import { StatusConsole } from '../planner/work-item-status'
import { Writable } from 'stream'

export interface Environment {
  processEnvs: { [key: string]: string | undefined }
  abortCtrl: AbortController
  cwd: string
  file: FileContext
  console: ConsoleContext
  status: StatusConsole
  stdout: Writable
  stderr: Writable
  stdoutColumns: number
}
