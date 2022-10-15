import { exec } from 'child_process'
import { platform } from 'os'
import { getLogs } from '../log'
import { AbortError } from './abort'
import { listenOnAbort } from '../utils/abort-event'
import { StatusScopedConsole } from '../planner/work-node-status'

export async function executeCommand(
  status: StatusScopedConsole,
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
        status.console('stdout', log)
      }
    })
    ps.stderr?.on('data', async (data) => {
      for (const log of getLogs(data)) {
        status.console('stderr', log)
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
