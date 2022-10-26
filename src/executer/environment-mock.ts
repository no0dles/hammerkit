import { statusConsole } from '../planner/work-node-status'
import { Environment } from './environment'
import { consoleContextMock } from '../console/console-context-mock'
import { getFileContext } from '../file/get-file-context'

export function environmentMock(): Environment {
  return {
    cwd: process.cwd(),
    file: getFileContext(process.cwd()),
    console: consoleContextMock(),
    abortCtrl: new AbortController(),
    processEnvs: {},
    status: statusConsole(),
  }
}
