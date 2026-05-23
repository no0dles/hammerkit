import { statusConsole } from '../planner/work-item-status'
import { Environment } from './environment'
import { getFileContext } from '../file/get-file-context'
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
    stdout: emptyWritable(),
    stderr: emptyWritable(),
    stdoutColumns: 80,
  }
}
