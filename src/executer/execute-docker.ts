import { awaitStream } from '../docker/stream'
import Dockerode, { Container, Exec, ExecInspectInfo } from 'dockerode'
import { sep, extname } from 'path'
import { ContainerWorkNode, isContainerWorkNode } from '../planner/work-node'
import { WorkNodePath } from '../planner/work-node-path'
import { platform } from 'os'
import { Environment } from './environment'
import { createHash } from 'crypto'
import { listenOnAbort } from '../utils/abort-event'
import { StatusScopedConsole } from '../planner/work-node-status'
import { ContainerWorkService } from '../planner/work-service'

interface WorkNodeVolume {
  name: string
  containerPath: string
}

export function generateId(generate: string): string {
  return createHash('sha1').update(generate).digest('hex')
}

export function getVolumeName(generate: string): string {
  return `hammerkit-${generateId(generate)}`
}

export async function getContainerVolumes(node: ContainerWorkNode): Promise<WorkNodeVolume[]> {
  const volumes: WorkNodeVolume[] = []

  for (const generate of node.generates) {
    const name = getVolumeName(generate.path)
    volumes.push({
      name,
      containerPath: generate.path,
    })
  }

  return volumes
}

export async function getContainerMounts(
  node: ContainerWorkNode | ContainerWorkService,
  context: Environment
): Promise<WorkNodePath[]> {
  const result: WorkNodePath[] = []

  if (isContainerWorkNode(node)) {
    for (const source of node.src) {
      const exists = await context.file.exists(source.absolutePath)

      if (exists) {
        result.push({
          localPath: source.absolutePath,
          containerPath: source.absolutePath,
        })
      } else {
        if (extname(source.absolutePath)) {
          await context.file.writeFile(source.absolutePath, '')
        } else {
          await context.file.createDirectory(source.absolutePath)
          result.push({
            localPath: source.absolutePath,
            containerPath: source.absolutePath,
          })
        }
      }
    }
  }

  for (const mount of node.mounts) {
    result.push(mount)
  }

  for (const volume of result) {
    const otherVolumes = result.filter(
      (v) => v.containerPath === volume.containerPath && v.localPath !== volume.localPath
    )
    if (otherVolumes.length > 0) {
      throw new Error(
        `duplicate container mount with different sources ${[
          volume.localPath,
          ...otherVolumes.map((ov) => ov.localPath),
        ].join(', ')}`
      )
    }
  }

  return result.filter((v, i) => result.findIndex((iv) => iv.containerPath == v.containerPath) === i)
}

let dockerInstance: Dockerode | null = null

export async function getDocker(status: StatusScopedConsole): Promise<Dockerode> {
  if (!dockerInstance) {
    dockerInstance = new Dockerode()

    try {
      await dockerInstance.version()
    } catch (e) {
      if (e instanceof Error && e.message.indexOf('ECONNREFUSED') >= 0) {
        status.write('error', `docker is not running, try running in local shell or start`)
      }

      throw e
    }
  }
  return dockerInstance
}

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
  docker: Dockerode,
  container: Container,
  cwd: string | undefined,
  cmd: string[],
  user: string | undefined,
  timeout: number | undefined,
  abort: AbortSignal
): Promise<ExecResult> {
  const exec = await container.exec({
    Cmd: cmd,
    WorkingDir: cwd,
    Tty: false,
    AttachStdout: true,
    AttachStdin: true,
    AttachStderr: true,
    User: user,
  })

  status.write('debug', `received exec id ${exec.id}`)
  const stream = await exec.start({ stdin: true, hijack: true, Detach: false, Tty: false })

  return new Promise<ExecResult>((resolve, reject) => {
    let resolved = false

    listenOnAbort(abort, () => {
      if (resolved) {
        return
      }

      resolved = true
      resolve({ type: 'canceled' })
    })

    awaitStream(status, docker, stream)
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
