import { statusConsole } from '../planner/work-node-status'
import { Environment } from './environment'
import { consoleContextMock } from '../console/console-context-mock'
import { getFileContext } from '../file/get-file-context'
import { getContainerCli } from './execute-docker'

export function environmentMock(cwd: string): Environment {
  return {
    cwd,
    file: getFileContext(cwd),
    console: consoleContextMock(),
    abortCtrl: new AbortController(),
    processEnvs: {},
    status: statusConsole(),
    docker: getContainerCli(),
  }
}
