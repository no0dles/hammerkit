import { spawn } from 'child_process'
import { platform } from 'os'
import { getLogs } from '../log'
import { AbortError } from './abort'
import { listenOnAbort } from '../utils/abort-event'
import { StatusScopedConsole } from '../planner/work-item-status'
import { Environment } from './environment'
import { getEnvironmentConfig } from '../utils/environment-config'

// how long a local command's process group gets to exit after SIGTERM before
// it is killed
function getStopTimeout(): number {
  return getEnvironmentConfig('HAMMERKIT_STOP_TIMEOUT_MS', 10000)
}

// A variable of the process. Windows ignores the case of their names and calls PATH
// `Path`, which a copy of process.env (`{ ...process.env }`) keeps.
export function processEnv(
  envs: { [key: string]: string | undefined },
  name: string,
  windows: boolean
): string | undefined {
  if (envs[name] !== undefined || !windows) {
    return envs[name]
  }
  const key = Object.keys(envs).find((key) => key.toUpperCase() === name.toUpperCase())
  return key !== undefined ? envs[key] : undefined
}

// powershell takes about half a minute to start when it has to work out its module
// path or the PATH itself, so the ones of the process are passed on
function shellEnvs(windows: boolean, environment: Environment): { [key: string]: string | undefined } {
  const value = processEnv(environment.processEnvs, 'PSModulePath', windows)
  return {
    ...(windows && value !== undefined ? { PSModulePath: value } : {}),
    PATH: processEnv(environment.processEnvs, 'PATH', windows),
  }
}

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
      env: { ...envs, ...shellEnvs(windows, environment) },
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
      stopGroup(ps.pid)
    })
  })
}

// SIGTERM the whole group, then SIGKILL whatever is still in it after
// HAMMERKIT_STOP_TIMEOUT_MS. The shell exiting doesn't end the wait: a child that ignores
// SIGTERM would otherwise outlive hammerkit.
function stopGroup(pid: number): void {
  if (!signalGroup(pid, 'SIGTERM')) {
    return
  }
  const deadline = Date.now() + getStopTimeout()
  const poll = setInterval(() => {
    if (!signalGroup(pid, 0)) {
      clearInterval(poll)
      return
    }
    if (Date.now() >= deadline) {
      signalGroup(pid, 'SIGKILL')
      clearInterval(poll)
    }
  }, 100)
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    // the group is already gone
    return false
  }
}
