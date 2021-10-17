import { awaitStream } from '../docker/stream'
import Dockerode, { Container, Exec, ExecInspectInfo } from 'dockerode'
import { pull } from '../docker/pull'
import { sep, extname } from 'path'
import { ContainerWorkNode, WorkNode } from '../planner/work-node'
import { WorkNodePath } from '../planner/work-node-path'
import { platform } from 'os'
import { templateValue } from '../planner/utils/template-value'
import { ExecutionContext } from './execution-context'
import { Environment } from './environment'
import { createHash } from 'crypto'
import { ensureVolumeExists } from './get-docker-executor'
import { WorkNodeConsole } from '../planner/work-node-status'
import { removeContainer } from '../docker/remove-container'
import { abortableFunction, AbortableFunctionContext } from '../utils/abortable-function'
import { getErrorMessage } from '../log'

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

export function getDocker(): Dockerode {
  if (!dockerInstance) {
    dockerInstance = new Dockerode()
  }
  return dockerInstance
}

export async function startContainer(node: WorkNode, container: Container): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const handle = setTimeout(() => {
      node.status.console.write('internal', 'warn', 'start of container is potentially stuck on start')
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

function convertToPosixPath(path: string) {
  if (platform() === 'win32') {
    return path
      .split(sep)
      .map((value, index) => (index === 0 && value.endsWith(':') ? '/' + value.substr(0, value.length - 1) : value))
      .join('/')
  }
  return path
}

export function executeDocker(
  node: ContainerWorkNode,
  context: ExecutionContext,
  abortCtrl: AbortController
): Promise<void> {
  return abortableFunction<void>(context.environment.console, abortCtrl.signal, async (ctx) => {
    node.status.console.write('internal', 'debug', `execute ${node.name} as docker task`)
    const docker = getDocker()

    const volumes = await getContainerVolumes(node)
    const mounts = await getContainerMounts(node, context.environment)

    ctx.checkForAbort()
    await pull(node.status.console, docker, node.image)

    ctx.checkForAbort()
    for (const volume of volumes) {
      await ensureVolumeExists(docker, volume.name)
    }

    const links: string[] = []
    for (const need of node.needs) {
      if (need.status.state.type !== 'ready') {
        throw new Error(`service ${need.name} is not running`)
      }
      links.push(`${need.status.state.containerName}:${need.name}`)
    }

    ctx.checkForAbort()
    node.status.console.write('internal', 'debug', `create container with image ${node.image} with ${node.shell}`)
    const container = await docker.createContainer({
      Image: node.image,
      Tty: true,
      Entrypoint: node.shell,
      Env: Object.keys(node.envs).map((k) => `${k}=${node.envs[k]}`),
      WorkingDir: convertToPosixPath(node.cwd),
      Labels: { app: 'hammerkit', 'hammerkit-id': node.id, 'hammerkit-type': 'task' },
      HostConfig: {
        Binds: [
          ...mounts.map((v) => `${v.localPath}:${convertToPosixPath(v.containerPath)}`),
          ...volumes.map((v) => `${v.name}:${convertToPosixPath(v.containerPath)}`),
        ],
        PortBindings: node.ports.reduce<{ [key: string]: { HostPort: string }[] }>((map, port) => {
          map[`${port.containerPort}/tcp`] = [{ HostPort: `${port.hostPort}` }]
          return map
        }, {}),
        Links: links,
        AutoRemove: true,
      },
      ExposedPorts: node.ports.reduce<{ [key: string]: Record<string, unknown> }>((map, port) => {
        map[`${port.containerPort}/tcp`] = {}
        return map
      }, {}),
    })

    ctx.addAbortFunction(async () => {
      try {
        await removeContainer(container)
      } catch (e) {
        node.status.console.write('internal', 'debug', `remove of container failed ${getErrorMessage(e)}`)
      }
    })

    const user =
      platform() === 'linux' || platform() === 'freebsd' || platform() === 'openbsd' || platform() === 'sunos'
        ? `${process.getuid()}:${process.getgid()}`
        : undefined

    for (const mount of mounts) {
      node.status.console.write('internal', 'debug', `bind mount ${mount.localPath}:${mount.containerPath}`)
    }
    for (const volume of volumes) {
      node.status.console.write('internal', 'debug', `volume mount ${volume.name}:${volume.containerPath}`)
    }

    node.status.console.write('internal', 'info', `starting container with image ${node.image}`)
    await startContainer(node, container)

    if (user) {
      const setUserPermission = async (directory: string) => {
        node.status.console.write('internal', 'debug', 'set permission on ' + directory)
        const result = await execCommand(
          ctx,
          node.status.console,
          docker,
          container,
          '/',
          ['chown', user, directory],
          undefined,
          undefined
        )
        if (result.type === 'timeout' || result.result.ExitCode !== 0) {
          node.status.console.write('internal', 'warn', `unable to set permissions for ${directory}`)
        }
      }

      await setUserPermission(node.cwd)
      for (const volume of volumes) {
        await setUserPermission(volume.containerPath)
      }
      for (const mount of mounts) {
        await setUserPermission(mount.containerPath)
      }
    }

    for (const cmd of node.cmds) {
      ctx.checkForAbort()

      const command = templateValue(cmd.cmd, node.envs)
      node.status.console.write('internal', 'info', `execute cmd ${command} in container`)
      const result = await execCommand(
        ctx,
        node.status.console,
        docker,
        container,
        convertToPosixPath(cmd.path),
        [node.shell, '-c', command],
        user,
        undefined
      )
      if (!result) {
        return
      }

      if (result.type === 'timeout') {
        throw new Error(`command ${command} timed out`)
      }

      if (result.result.ExitCode !== 0) {
        node.status.console.write('internal', 'error', `command ${command} failed with ${result.result.ExitCode}`)
        throw new Error(`command ${command} failed with ${result.result.ExitCode}`)
      }
    }
  })
}

export type ExecResult = { type: 'result'; result: ExecInspectInfo } | { type: 'timeout' }

export async function execCommand(
  abortContext: AbortableFunctionContext,
  console: WorkNodeConsole,
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

  console.write('internal', 'debug', `received exec id ${exec.id}`)
  const stream = await exec.start({ stdin: true, hijack: true, Detach: false, Tty: false })

  return new Promise<ExecResult>((resolve, reject) => {
    let resolved = false

    awaitStream(console, docker, stream)
      .then(() => {
        if (resolved) {
          return
        }

        abortContext.checkForAbort()

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
