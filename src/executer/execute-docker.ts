import { awaitStream } from '../docker/stream'
import Dockerode, { Container, Exec, ExecInspectInfo } from 'dockerode'
import { sep, extname } from 'path'
import { ContainerWorkNode, WorkNode } from '../planner/work-node'
import { WorkNodePath } from '../planner/work-node-path'
import { platform } from 'os'
import { Environment } from './environment'
import { createHash } from 'crypto'
import { AbortableFunctionContext } from '../utils/abortable-function'
import { WorkService } from '../planner/work-service'

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

export async function getContainerMounts(node: ContainerWorkNode, context: Environment): Promise<WorkNodePath[]> {
  const result: WorkNodePath[] = []

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

export async function getDocker(nodeOrService: WorkNode | WorkService): Promise<Dockerode> {
  if (!dockerInstance) {
    dockerInstance = new Dockerode()

    try {
      await dockerInstance.version()
    } catch (e) {
      if (e instanceof Error && e.message.indexOf('ECONNREFUSED') >= 0) {
        nodeOrService.status.write('error', `docker is not running, try running in local shell or start`)
      }

      throw e
    }
  }
  return dockerInstance
}

export async function startContainer(node: WorkNode, container: Container): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const handle = setTimeout(() => {
      node.status.write('warn', 'start of container is potentially stuck on start')
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

export type ExecResult = { type: 'result'; result: ExecInspectInfo } | { type: 'timeout' }

export async function execCommand(
  node: WorkNode | WorkService,
  docker: Dockerode,
  container: Container,
  cwd: string | undefined,
  cmd: string[],
  user: string | undefined,
  timeout: number | undefined
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

  node.status.write('debug', `received exec id ${exec.id}`)
  const stream = await exec.start({ stdin: true, hijack: true, Detach: false, Tty: false })

  return new Promise<ExecResult>((resolve, reject) => {
    let resolved = false

    awaitStream(node, docker, stream)
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
    } else {
      //pollStatus(abortContext, exec, resolve, reject)
    }
  })
}

export function pollStatus(
  abortContext: AbortableFunctionContext,
  exec: Exec,
  resolve: (result: ExecResult) => void,
  reject: (err: Error) => void
): void {
  if (abortContext.isAborted()) {
    return
  }

  exec
    .inspect()
    .then((result) => {
      if (!result.Running) {
        resolve({ type: 'result', result })
      } else {
        setTimeout(() => pollStatus(abortContext, exec, resolve, reject), 50)
      }
    })
    .catch(reject)
}
