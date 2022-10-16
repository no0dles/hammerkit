import { getFileContextMock } from '../file/get-file-context-mock'
import { statusConsole } from '../planner/work-node-status'
import { Environment } from './environment'
import { consoleContextMock } from '../console/console-context-mock'

export function environmentMock(): Environment {
  return {
    cwd: '/home/user',
    file: getFileContextMock(),
    console: consoleContextMock(),
    abortCtrl: new AbortController(),
    processEnvs: {},
    status: statusConsole(),
  }
}
