import { awaitStream } from '../docker/stream'
import Dockerode, { Container, ExecInspectInfo } from 'dockerode'
import { sep } from 'path'
import { platform } from 'os'
import { Environment } from './environment'
import { listenOnAbort } from '../utils/abort-event'
import { StatusScopedConsole } from '../planner/work-item-status'
import { WorkDockerEnvironment } from '../planner/work-environment'

let dockerInstance: Dockerode | null = null

// Without options dockerode reads DOCKER_HOST and the TLS variables; passing
// `{ host: undefined }` would overwrite the host it parsed from DOCKER_HOST.
export function createDockerClient(host: string | undefined): Dockerode {
  return host ? new Dockerode({ host }) : new Dockerode()
}

export function getContainerCli(workEnvironment: WorkDockerEnvironment): Dockerode {
  if (!dockerInstance) {
    dockerInstance = createDockerClient(workEnvironment.host)
  }
  return dockerInstance
}

export async function startContainer(status: StatusScopedConsole, container: Container): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const handle = setTimeout(() => {
      status.write('warn', 'start of container is potentially stuck on start')
    }, 10000)
    container
      .start()
      .then(() => {
        clearTimeout(handle)
        resolve()
      })
      .catch((e) => {
        clearTimeout(handle)
        if ('json' in e && 'message' in e.json) {
          const errorMessage = e.json.message
          const portBlocked = /Bind for .*:\d+ failed: port is already allocated/.exec(errorMessage)
          if (portBlocked) {
            reject(new Error(portBlocked[0]))
          } else {
            reject(new Error(errorMessage))
          }
        } else if ('json' in e && e.json instanceof Buffer) {
          reject(new Error(e.json.toString()))
        } else {
          reject(e)
        }
      })
  })
}

export function convertToPosixPath(path: string): string {
  if (platform() === 'win32') {
    return path
      .split(sep)
      .map((value, index) => (index === 0 && value.endsWith(':') ? '/' + value.substring(0, value.length - 1) : value))
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
  abort: AbortSignal
): Promise<ExecResult> {
  const abortController = new AbortController()
  const exec = await container.exec({
    Cmd: cmd,
    WorkingDir: cwd,
    Tty: false,
    AttachStdout: true,
    AttachStdin: true,
    AttachStderr: true,
    User: user ?? undefined,
    abortSignal: abortController.signal,
  })

  status.write('debug', `received exec id ${exec.id}`)
  const stream = await exec.start({
    stdin: true,
    hijack: true,
    Detach: false,
    Tty: false,
    abortSignal: abortController.signal,
  })

  let timeoutHandle: NodeJS.Timeout | undefined = undefined
  return new Promise<ExecResult>((resolve, reject) => {
    let resolved = false

    const abortListener = listenOnAbort(abort, () => {
      if (resolved) {
        return
      }

      resolved = true
      resolve({ type: 'canceled' })
      abortController.abort()
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }
    })

    awaitStream(status, stream)
      .then(() => {
        if (resolved) {
          return
        }

        return exec.inspect().then((result) => {
          if (resolved) {
            return
          }

          abortListener.close()
          resolve({ type: 'result', result })
          resolved = true
          abortController.abort()
          if (timeoutHandle) {
            clearTimeout(timeoutHandle)
          }
        })
      })
      .catch(reject)

    if (timeout) {
      timeoutHandle = setTimeout(() => {
        if (resolved) {
          return
        }

        abortListener.close()
        resolve({ type: 'timeout' })
        resolved = true
        abortController.abort()
      }, timeout)
    }
  })
}

// Empty a directory inside a running container, as root. Volumes are emptied
// this way rather than recreated: Docker refuses to remove a volume while any
// container (a running dependent's, say) still mounts it.
export async function clearContainerDirectory(
  status: StatusScopedConsole,
  environment: Environment,
  container: Container,
  path: string
): Promise<void> {
  const result = await execCommand(
    status,
    environment,
    container,
    '/',
    ['sh', '-c', 'rm -rf "$1"/* "$1"/.[!.]* "$1"/..?*', 'sh', convertToPosixPath(path)],
    null,
    undefined,
    environment.abortCtrl.signal
  )
  if (result.type !== 'result' || result.result.ExitCode !== 0) {
    throw new Error(`unable to empty ${path}`)
  }
}
