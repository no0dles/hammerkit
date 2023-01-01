import { FileContext } from '../file/file-context'
import { ConsoleContext } from '../console/console-context'
import { StatusConsole } from '../planner/work-node-status'
import Dockerode from 'dockerode'
import { Writable } from 'stream'

export interface Environment {
  processEnvs: { [key: string]: string | undefined }
  abortCtrl: AbortController
  cwd: string
  file: FileContext
  console: ConsoleContext
  status: StatusConsole
  docker: Dockerode
  stdout: Writable
  stdoutColumns: number
}
