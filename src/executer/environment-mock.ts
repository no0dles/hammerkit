import { statusConsole } from '../planner/work-node-status'
import { Environment } from './environment'
import { Writable } from 'stream'
import { getFileContext } from '../file/get-file-context'
import { getContainerCli } from './execute-docker'
import { consoleContext } from '../log'
import { emptyWritable } from '../utils/empty-writable'

export function environmentMock(cwd: string): Environment {
  return {
    cwd,
    file: getFileContext(cwd),
    console: consoleContext(emptyWritable()),
    abortCtrl: new AbortController(),
    processEnvs: {},
    status: statusConsole(emptyWritable()),
    docker: getContainerCli(),
    stdout: emptyWritable(),
    stdoutColumns: 80,
  }
}
