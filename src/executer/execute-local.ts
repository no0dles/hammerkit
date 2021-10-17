import { exec } from 'child_process'
import { getLogs } from '../log'
import { WorkNode } from '../planner/work-node'
import { templateValue } from '../planner/utils/template-value'
import { platform } from 'os'
import { ExecutionContext } from './execution-context'
import { getProcessEnvs } from '../environment/get-process-env'
import { listenOnAbort } from '../utils/abort-event'

export async function executeLocal(node: WorkNode, arg: ExecutionContext, abortCtrl: AbortController): Promise<void> {
  node.status.console.write('internal', 'info', `execute ${node.name} locally`)
  const envs = getProcessEnvs(node.envs, arg.environment)
  for (const cmd of node.cmds) {
    if (abortCtrl.signal.aborted) {
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
        if (abortCtrl.signal.aborted) {
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
      listenOnAbort(abortCtrl.signal, () => {
        ps.kill()
      })
    })
  }
}
