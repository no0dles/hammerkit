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
import { listenOnAbort } from '../utils/abort-event'

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

export function checkIfAbort(cancelDefer: AbortController): void {
  if (cancelDefer.signal.aborted) {
    throw new Error('canceled')
  }
}

export async function executeDocker(
  node: ContainerWorkNode,
  context: ExecutionContext,
  cancelDefer: AbortController
): Promise<void> {
  node.status.console.write('internal', 'debug', `execute ${node.name} as docker task`)
  const docker = getDocker()

  const volumes = await getContainerVolumes(node)
  const mounts = await getContainerMounts(node, context.environment)

  checkIfAbort(cancelDefer)
  await pull(node, docker, node.image)

  checkIfAbort(cancelDefer)
  for (const volume of volumes) {
    await ensureVolumeExists(docker, volume.name)
  }

  checkIfAbort(cancelDefer)
  node.status.console.write('internal', 'debug', `create container with image ${node.image} with ${node.shell}`)
  const container = await docker.createContainer({
    Image: node.image,
    Tty: true,
    Entrypoint: node.shell,
    Env: Object.keys(node.envs).map((k) => `${k}=${node.envs[k]}`),
    WorkingDir: convertToPosixPath(node.cwd),
    Labels: { app: 'hammerkit' },
    HostConfig: {
      Binds: [
        ...mounts.map((v) => `${v.localPath}:${convertToPosixPath(v.containerPath)}`),
        ...volumes.map((v) => `${v.name}:${convertToPosixPath(v.containerPath)}`),
      ],
      PortBindings: node.ports.reduce<{ [key: string]: { HostPort: string }[] }>((map, port) => {
        map[`${port.containerPort}/tcp`] = [{ HostPort: `${port.hostPort}` }]
        return map
      }, {}),
      AutoRemove: true,
    },
    ExposedPorts: node.ports.reduce<{ [key: string]: Record<string, unknown> }>((map, port) => {
      map[`${port.containerPort}/tcp`] = {}
      return map
    }, {}),
  })

  listenOnAbort(cancelDefer.signal, () => {
    container.remove({ force: true }).catch((e) => {
      if (e.statusCode !== 404) {
        node.status.console.write('internal', 'debug', `remove of container failed ${e.message}`)
      }
    })
  })

  const user =
    platform() === 'linux' || platform() === 'freebsd' || platform() === 'openbsd' || platform() === 'sunos'
      ? `${process.getuid()}:${process.getgid()}`
      : undefined

  try {
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
        const result = await execCommand(node, docker, container, '/', ['chown', user, directory], undefined)
        if (!result || result.ExitCode !== 0) {
          node.status.console.write('internal', 'warn', `unable to set permissions for ${directory}`)
        }
      }

      await setUserPermission(node.cwd)
      for (const mount of mounts) {
        await setUserPermission(mount.containerPath)
      }
    }

    for (const cmd of node.cmds) {
      checkIfAbort(cancelDefer)

      const command = templateValue(cmd.cmd, node.envs)
      node.status.console.write('internal', 'info', `execute cmd ${command} in container`)
      const result = await execCommand(
        node,
        docker,
        container,
        convertToPosixPath(cmd.path),
        [node.shell, '-c', command],
        user
      )
      if (!result) {
        return
      }

      if (result.ExitCode !== 0) {
        node.status.console.write('internal', 'error', `command ${command} failed with ${result.ExitCode}`)
        throw new Error(`command ${command} failed with ${result.ExitCode}`)
      }
    }
  } finally {
    try {
      node.status.console.write('internal', 'debug', `remove container`)
      await container.remove({ force: true })
    } catch (e) {
      if (e.statusCode !== 404) {
        node.status.console.write('internal', 'debug', `remove of container failed ${e.message}`)
      }
    }
  }
}

export async function execCommand(
  node: ContainerWorkNode,
  docker: Dockerode,
  container: Container,
  cwd: string,
  cmd: string[],
  user: string | undefined
): Promise<ExecInspectInfo | null> {
  const exec = await container.exec({
    Cmd: cmd,
    WorkingDir: cwd,
    Tty: false,
    AttachStdout: true,
    AttachStdin: true,
    AttachStderr: true,
    User: user,
  })

  node.status.console.write('internal', 'debug', `received exec id ${exec.id}`)
  const stream = await exec.start({ stdin: true, hijack: true, Detach: false, Tty: false })

  return new Promise<ExecInspectInfo | null>((resolve, reject) => {
    awaitStream(node, docker, stream)
      .then(() => exec.inspect())
      .then(resolve)
      .catch(reject)

    pollStatus(exec, resolve, reject)
  })
}

export function pollStatus(exec: Exec, resolve: (result: ExecInspectInfo) => void, reject: (err: Error) => void): void {
  exec
    .inspect()
    .then((result) => {
      if (!result.Running) {
        resolve(result)
      } else {
        setTimeout(() => pollStatus(exec, resolve, reject), 50)
      }
    })
    .catch(reject)
}
