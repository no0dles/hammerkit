import { getFileContext } from '../file/get-file-context'
import { statusConsole } from '../planner/work-node-status'
import { consoleContext } from '../log'
import { Environment } from '../executer/environment'

export function getTestContext(cwd: string): Environment {
  const context: Environment = {
    processEnvs: { ...process.env },
    abortCtrl: new AbortController(),
    cwd,
    file: getFileContext(cwd),
    console: consoleContext(),
    status: statusConsole(),
  }
  return context
}
