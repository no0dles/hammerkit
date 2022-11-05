import { awaitStream } from '../docker/stream'
import Dockerode, { Container, ExecInspectInfo } from 'dockerode'
import { sep } from 'path'
import { platform } from 'os'
import { Environment } from './environment'
import { listenOnAbort } from '../utils/abort-event'
import { StatusScopedConsole } from '../planner/work-node-status'

let dockerInstance: Dockerode | null = null

export function getContainerCli(): Dockerode {
  if (!dockerInstance) {
    dockerInstance = new Dockerode()
  }
  return dockerInstance
}

// export async function getDocker(status: StatusScopedConsole): Promise<Dockerode> {
//   if (!dockerInstance) {
//     dockerInstance = new Dockerode()
//
//     try {
//       await dockerInstance.version()
//     } catch (e) {
//       if (e instanceof Error && e.message.indexOf('ECONNREFUSED') >= 0) {
//         status.write('error', `docker is not running, try running in local shell or start`)
//       }
//
//       throw e
//     }
//   }
//   return dockerInstance
// }

export async function startContainer(status: StatusScopedConsole, container: Container): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const handle = setTimeout(() => {
      status.write('warn', 'start of container is potentially stuck on start')
    }, 1000)
    container
      .start()
      .then(() => {
        clearTimeout(handle)
        resolve()
      })
      .catch((e) => {
        clearTimeout(handle)
        reject(e)
      })
  })
}

export function convertToPosixPath(path: string): string {
  if (platform() === 'win32') {
    return path
      .split(sep)
      .map((value, index) => (index === 0 && value.endsWith(':') ? '/' + value.substr(0, value.length - 1) : value))
      .join('/')
  }
  return path
}

export type ExecResult = { type: 'result'; result: ExecInspectInfo } | { type: 'timeout' } | { type: 'canceled' }

export async function execCommand(
  status: StatusScopedConsole,
  environment: Environment,
  container: Container,
  cwd: string | undefined,
  cmd: string[],
  user: string | null,
  timeout: number | undefined,
  abort: AbortSignal | undefined
): Promise<ExecResult> {
  const exec = await container.exec({
    Cmd: cmd,
    WorkingDir: cwd,
    Tty: false,
    AttachStdout: true,
    AttachStdin: true,
    AttachStderr: true,
    User: user ?? undefined,
  })

  status.write('debug', `received exec id ${exec.id}`)
  const stream = await exec.start({ stdin: true, hijack: true, Detach: false, Tty: false })

  return new Promise<ExecResult>((resolve, reject) => {
    let resolved = false

    if (abort) {
      listenOnAbort(abort, () => {
        if (resolved) {
          return
        }

        resolved = true
        resolve({ type: 'canceled' })
      })
    }

    awaitStream(status, stream)
      .then(() => {
        if (resolved) {
          return
        }

        return exec.inspect().then((result) => {
          if (resolved) {
            return
          }

          resolve({ type: 'result', result })
          resolved = true
        })
      })
      .catch(reject)

    if (timeout) {
      setTimeout(() => {
        if (resolved) {
          return
        }

        resolve({ type: 'timeout' })
        resolved = true
      }, timeout)
    }
  })
}
