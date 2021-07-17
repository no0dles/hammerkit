import { getProcessEnvs } from '../envs/process-env'
import { exec } from 'child_process'
import { getLogs } from '../log'
import { WorkNode } from '../planner/work-node'
import { Defer } from '../defer'
import { ExecutionContext } from '../run-arg'
import { templateValue } from '../planner/utils/template-value'
import { platform } from 'os'

export async function executeLocal(node: WorkNode, arg: ExecutionContext, cancelDefer: Defer<void>): Promise<void> {
  node.status.console.write('internal', 'info', `execute ${node.name} locally`)
  const envs = getProcessEnvs(node.envs, arg.context)
  for (const cmd of node.cmds) {
    if (cancelDefer.isResolved) {
      return
    }

    const command = templateValue(cmd.cmd, envs)
    await new Promise<void>((resolve, reject) => {
      node.status.console.write('internal', 'info', `execute cmd ${command} locally`)
      const ps = exec(command, {
        env: envs,
        cwd: cmd.path,
        shell: platform() === 'win32' ? 'powershell.exe' : undefined,
      })
      ps.stdout?.on('data', (data) => {
        for (const log of getLogs(data)) {
          node.status.console.write('process', 'info', log)
        }
      })
      ps.stderr?.on('data', (data) => {
        for (const log of getLogs(data)) {
          node.status.console.write('process', 'info', log)
        }
      })
      ps.on('error', (err) => {
        node.status.console.write('process', 'error', err.message)
      })
      ps.on('close', (code) => {
        if (cancelDefer.isResolved) {
          reject(new Error('canceled'))
          return
        }

        if (code !== 0 && code !== null) {
          const message = `failed with code ${code}`
          node.status.console.write('process', 'error', message)
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
