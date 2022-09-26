import { WorkNode } from '../planner/work-node'
import { ProgressHub } from './emitter'
import { HammerkitEvent } from './events'
import { exec } from 'child_process'
import { platform } from 'os'
import { getLogs } from '../log'
import { AbortError } from './abort'
import { listenOnAbort } from '../utils/abort-event'

export async function executeCommand(
  node: WorkNode,
  eventBus: ProgressHub<HammerkitEvent>,
  abortSignal: AbortSignal,
  cwd: string,
  command: string,
  envs: { [key: string]: string }
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const ps = exec(command, {
      env: envs,
      cwd,
      shell: platform() === 'win32' ? 'powershell.exe' : undefined,
    })
    ps.stdout?.on('data', async (data) => {
      for (const log of getLogs(data)) {
        node.console.write('stdout', log)
      }
    })
    ps.stderr?.on('data', async (data) => {
      for (const log of getLogs(data)) {
        node.console.write('stderr', log)
      }
    })
    ps.on('error', (err) => {
      reject(err)
    })
    ps.on('close', (code) => {
      if (abortSignal.aborted) {
        reject(new AbortError())
        return
      }

      resolve(code ?? 0)
    })

    listenOnAbort(abortSignal, () => {
      ps.kill()
    })
  })
}
