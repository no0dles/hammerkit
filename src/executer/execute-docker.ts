import { awaitStream } from '../docker/stream'
import Dockerode, { Container, Exec, ExecInspectInfo } from 'dockerode'
import { pull } from '../docker/pull'
import { sep, extname } from 'path'
import { ContainerWorkNode } from '../planner/work-node'
import { WorkNodePath } from '../planner/work-node-path'
import { platform } from 'os'
import { templateValue } from '../planner/utils/template-value'
import { ExecutionContext } from './execution-context'
import { Environment } from './environment'
import { Defer } from '../utils/defer'
import { createHash } from 'crypto'
import { execute } from './execute'

interface WorkNodeVolume {
  name: string
  containerPath: string
}

export async function getContainerVolumes(node: ContainerWorkNode, context: Environment): Promise<WorkNodeVolume[]> {
  const volumes: WorkNodeVolume[] = []

  for (const generate of node.generates) {
    const name = `hammerkit-${createHash('sha1').update(generate).digest('hex')}`
    volumes.push({
      name,
      containerPath: generate,
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

class Lock {
  private count = 0
  private queue: Defer<LockLease>[] = []

  constructor(private total: number) {}

  private enqueueQueue() {
    const item = this.queue.pop()
    if (item) {
      item.resolve(this.lease())
    }
  }

  private lease(): LockLease {
    return {
      close: () => {
        this.count--
        this.enqueueQueue()
      },
    }
  }

  async acquire(): Promise<LockLease> {
    if (this.count < this.total) {
      this.count++
      return this.lease()
    } else {
      const defer = new Defer<LockLease>()
      this.queue.push(defer)
      return defer.promise
    }
  }
}

interface LockLease {
  close(): void
}

let dockerInstance: Dockerode | null = null
const instanceLock = new Lock(2)

function getDocker(): Dockerode {
  if (!dockerInstance) {
    dockerInstance = new Dockerode()
  }
  return dockerInstance
}

async function useDocker(fn: (docker: Dockerode) => Promise<void>): Promise<void> {
  const lease = await instanceLock.acquire()
  try {
    const docker = getDocker()
    await fn(docker)
  } finally {
    lease.close()
  }
}

async function startContainer(container: Container): Promise<void> {
  const defer = new Defer<void>()
  // TODO watch if start takes too long to finish, report warning
  container.start().then(() => {
    defer.resolve()
  })
  return defer.promise
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

export async function executeDocker(
  node: ContainerWorkNode,
  context: ExecutionContext,
  cancelDefer: Defer<void>
): Promise<void> {
  node.status.console.write('internal', 'debug', `execute ${node.name} as docker task`)
  await useDocker(async (docker) => {
    const volumes = await getContainerVolumes(node, context.environment)
    const mounts = await getContainerMounts(node, context.environment)

    await pull(node, docker, node.image)

    for (const volume of volumes) {
      try {
        const existing = await docker.getVolume(volume.name)
        await existing.inspect()
      } catch (e) {
        await docker.createVolume({
          Name: volume.name,
          Driver: 'local',
          Labels: { app: 'hammerkit' },
        })
      }
    }

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
      },
      ExposedPorts: node.ports.reduce<{ [key: string]: Record<string, unknown> }>((map, port) => {
        map[`${port.containerPort}/tcp`] = {}
        return map
      }, {}),
    })

    for (const mount of mounts) {
      node.status.console.write('internal', 'debug', `bind mount ${mount.localPath}:${mount.containerPath}`)
    }
    for (const volume of volumes) {
      node.status.console.write('internal', 'debug', `volume mount ${volume.name}:${volume.containerPath}`)
    }

    cancelDefer.promise.then(() => {
      container.remove({ force: true }).catch(() => {
        node.status.console.write('internal', 'debug', `remove of container failed`)
      })
    })

    const user =
      platform() === 'linux' || platform() === 'freebsd' || platform() === 'openbsd' || platform() === 'sunos'
        ? `${process.getuid()}:${process.getgid()}`
        : undefined

    try {
      node.status.console.write('internal', 'info', `starting container with image ${node.image}`)

      await startContainer(container)

      if (user) {
        const setUserPermission = async (directory: string) => {
          node.status.console.write('internal', 'debug', 'set permission on ' + directory)
          const result = await execCommand(node, docker, container, '/', ['chown', user, directory], undefined)
          if (result.ExitCode !== 0) {
            node.status.console.write('internal', 'warn', `unable to set permissions for ${directory}`)
          }
        }

        await setUserPermission(node.cwd)
        for (const mount of mounts) {
          await setUserPermission(mount.containerPath)
        }
      }

      for (const cmd of node.cmds) {
        if (cancelDefer.isResolved) {
          return
        }

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
        if (result.ExitCode !== 0) {
          node.status.console.write('internal', 'error', `command ${command} failed with ${result.ExitCode}`)
          throw new Error(`command ${command} failed with ${result.ExitCode}`)
        }
      }
    } finally {
      node.status.console.write('internal', 'debug', `remove container`)
      await container.remove({ force: true }).catch(() => {
        node.status.console.write('internal', 'debug', `remove of container failed`)
      })
    }
  })
}

async function execCommand(
  node: ContainerWorkNode,
  docker: Dockerode,
  container: Container,
  cwd: string,
  cmd: string[],
  user: string | undefined
) {
  const exec = await container.exec({
    Cmd: cmd,
    WorkingDir: cwd,
    Tty: false,
    AttachStdout: true,
    AttachStdin: true,
    AttachStderr: true,
    User: user,
  })

  const defer = new Defer<ExecInspectInfo>()
  node.status.console.write('internal', 'debug', `received exec id ${exec.id}`)
  const stream = await exec.start({ stdin: true, hijack: true, Detach: false, Tty: false })
  awaitStream(node, docker, stream).then(async () => {
    if (!defer.isResolved) {
      const result = await exec.inspect()
      if (!defer.isResolved) {
        defer.resolve(result)
      }
    }
  })
  pollStatus(exec, defer)
  return defer.promise
}

function pollStatus(exec: Exec, defer: Defer<ExecInspectInfo>): void {
  async function inspect() {
    const result = await exec.inspect()
    if (!result.Running && !defer.isResolved) {
      defer.resolve(result)
    }

    if (!defer.isResolved) {
      setTimeout(() => inspect(), 50)
    }
  }

  inspect()
}
