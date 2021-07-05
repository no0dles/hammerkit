import { getProcessEnvs } from '../envs/process-env'
import { exec } from 'child_process'
import {getLogs, writeLog} from '../log';
import { WorkNode } from '../planner/work-node'
import {Defer} from '../defer';
import {ExecutionContext} from '../run-arg';

export async function executeLocal(node: WorkNode, arg: ExecutionContext, cancelDefer: Defer<void>): Promise<void> {
  writeLog(node.status.stdout, 'info', `execute ${node.name} locally`)
  const envs = getProcessEnvs(node.envs, arg.context)
  for (const cmd of node.cmds) {
    if (cancelDefer.isResolved) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      writeLog(node.status.stdout, 'info', `execute cmd ${cmd.cmd} locally`)
      const ps = exec(cmd.cmd, {
        env: envs,
        cwd: cmd.path,
      })
      ps.stdout?.on('data', (data) => {
        for (const log of getLogs(data)) {
          writeLog(node.status.stdout, 'info', log)
        }
      })
      ps.stderr?.on('data', (data) => {
        for (const log of getLogs(data)) {
          writeLog(node.status.stdout, 'info', log)
        }
      })
      ps.on('error', (err) => {
        writeLog(node.status.stdout, 'error', err.message)
      })
      ps.on('close', (code) => {
        if (cancelDefer.isResolved) {
          reject(new Error('canceled'))
          return
        }

        if (code !== 0 && code !== null) {
          const message = `failed with code ${code}`
          writeLog(node.status.stdout, 'error', message)
          reject(new Error(message))
        } else {
          resolve()
        }
      })
      cancelDefer.promise.then(() => {
        ps.kill()
      })
    })
  }
}
