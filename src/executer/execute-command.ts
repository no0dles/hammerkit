import { spawn } from 'child_process'
import { platform } from 'os'
import { getLogs } from '../log'
import { AbortError } from './abort'
import { listenOnAbort } from '../utils/abort-event'
import { StatusScopedConsole } from '../planner/work-item-status'
import { Environment } from './environment'

export async function executeCommand(
  status: StatusScopedConsole,
  abortSignal: AbortSignal,
  cwd: string,
  command: string,
  envs: { [key: string]: string },
  environment: Environment
): Promise<number> {
  const windows = platform() === 'win32'
  return new Promise<number>((resolve, reject) => {
    const ps = spawn(command, {
      env: { ...envs, PATH: environment.processEnvs['PATH'] },
      cwd,
      shell: windows ? 'powershell.exe' : true,
      // its own process group, so an abort reaches every process the command
      // started — the shell may run them as children (dash always does), and
      // they would keep running and holding the output open
      detached: !windows,
    })
    // decode across chunk boundaries, so a multi-byte character split between
    // two chunks stays intact
    ps.stdout?.setEncoding('utf8')
    ps.stderr?.setEncoding('utf8')
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
      abortListener.close()

      if (abortSignal.aborted) {
        reject(new AbortError())
        return
      }

      resolve(code ?? 0)
    })

    const abortListener = listenOnAbort(abortSignal, () => {
      if (windows || !ps.pid) {
        ps.kill()
        return
      }
      try {
        process.kill(-ps.pid, 'SIGTERM')
      } catch {
        // the group is already gone
      }
    })
  })
}
