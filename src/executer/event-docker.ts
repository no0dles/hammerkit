import { EventBus } from './event-bus'
import {
  NodeCleanupEvent,
  NodePruneStateEvent,
  NodeRestoreStateEvent,
  NodeStoreStateEvent,
  SchedulerStartContainerNodeEvent,
  SchedulerStartServiceEvent,
  ServiceCleanupEvent,
} from './events'
import { pull } from '../docker/pull'
import { ensureVolumeExists, existsVolume } from './get-docker-executor'
import {
  convertToPosixPath,
  execCommand,
  generateId,
  getContainerMounts,
  getContainerVolumes,
  getDocker,
  getVolumeName,
  startContainer,
} from './execute-docker'
import { Environment } from './environment'
import { AbortError, checkForAbort } from './abort'
import { removeContainer } from '../docker/remove-container'
import { getErrorMessage } from '../log'
import { platform } from 'os'
import { templateValue } from '../planner/utils/template-value'
import { Container } from 'dockerode'
import { logStream } from '../docker/stream'
import { ExecutionBuildServiceHealthCheck } from '../parser/build-file-service'
import { join } from 'path'

export function attachDockerExecutor(eventBus: EventBus, environment: Environment) {
  eventBus.on<NodeCleanupEvent>('node-cleanup', async (evt) => {
    const docker = await getDocker(evt.node)

    const containers = await docker.listContainers({
      all: true,
      filters: {
        label: [`hammerkit-id=${evt.node.id}`],
      },
    })
    for (const container of containers) {
      await removeContainer(docker.getContainer(container.Id))
    }
  })
  eventBus.on<ServiceCleanupEvent>('service-cleanup', async (evt) => {
    const docker = await getDocker(evt.service)

    const containers = await docker.listContainers({
      all: true,
      filters: {
        label: [`hammerkit-id=${evt.service.id}`],
      },
    })
    for (const container of containers) {
      await removeContainer(docker.getContainer(container.Id))
    }
  })

  eventBus.on<NodePruneStateEvent>('node-prune-state', async (evt) => {
    const docker = await getDocker(evt.node)

    for (const generate of evt.node.generates) {
      if (generate.inherited) {
        continue
      }

      const volumeName = getVolumeName(generate.path)
      const volumeExists = await existsVolume(docker, volumeName)
      if (volumeExists) {
        evt.node.status.write('info', `remove volume ${volumeName}`)
        const volume = await docker.getVolume(volumeName)
        await volume.remove()
      } else {
        evt.node.status.write('info', `generate ${generate} has no volume ${volumeName}`)
      }
    }
  })

  eventBus.on<NodeRestoreStateEvent>('node-restore-state', async (evt) => {
    const docker = await getDocker(evt.node)
    for (const generate of evt.node.generates) {
      if (generate.inherited) {
        continue
      }

      const id = generateId(generate.path)
      const volumeName = getVolumeName(generate.path)

      const sourcePath = join(evt.path, 'generates', `${id}.tar`)
      if (!(await environment.file.exists(sourcePath))) {
        continue
      }

      await ensureVolumeExists(docker, volumeName)

      evt.node.status.write('info', `import data into volume ${volumeName}`)
      const res = await docker.run('ubuntu', ['bash', '-c', `cd /data && tar xvf /import/${id}.tar --strip 1`], [], {
        HostConfig: {
          Binds: [`${volumeName}:/data`, `${sourcePath}:/import/${id}.tar`],
          AutoRemove: true,
        },
      })
      if (res[0].StatusCode !== 0) {
        throw new Error(res[0].Error)
      }
    }
  })

  eventBus.on<NodeStoreStateEvent>('node-store-state', async (evt) => {
    const docker = await getDocker(evt.node)
    for (const generate of evt.node.generates) {
      if (generate.inherited) {
        continue
      }

      const id = generateId(generate.path)
      const volumeName = getVolumeName(generate.path)

      const volumeExists = await existsVolume(docker, volumeName)
      if (!volumeExists) {
        evt.node.status.write('info', `generate ${generate} has no volume ${volumeName}`)
        continue
      }

      const targetPath = join(evt.path, 'generates')
      await environment.file.createDirectory(targetPath)
      evt.node.status.write('info', `export data from volume ${volumeName}`)
      const res = await docker.run('ubuntu', ['tar', 'cvf', `/export/${id}.tar`, '/data'], [], {
        HostConfig: {
          Binds: [`${volumeName}:/data`, `${targetPath}:/export`],
          AutoRemove: true,
        },
      })
      if (res[0].StatusCode !== 0) {
        throw new Error(res[0].Error)
      }
    }
  })

  eventBus.on<SchedulerStartContainerNodeEvent>('scheduler-start-container-node', async (evt) => {
    let container: Container | null = null

    try {
      const docker = await getDocker(evt.node)

      const volumes = await getContainerVolumes(evt.node)
      const mounts = await getContainerMounts(evt.node, environment)

      checkForAbort(evt.abortSignal)
      await pull(evt.node, docker, evt.node.image)

      checkForAbort(evt.abortSignal)
      for (const volume of volumes) {
        await ensureVolumeExists(docker, volume.name)
      }

      const links: string[] = []
      for (const need of evt.node.needs) {
        const container = evt.serviceContainers[need.id]
        if (container) {
          throw new Error(`service ${need.name} is not running`)
        }
        links.push(`${container}:${need.name}`)
      }

      checkForAbort(evt.abortSignal)
      evt.node.status.write('debug', `create container with image ${evt.node.image} with ${evt.node.shell}`)
      container = await docker.createContainer({
        Image: evt.node.image,
        Tty: true,
        Entrypoint: evt.node.shell,
        Env: Object.keys(evt.node.envs).map((k) => `${k}=${evt.node.envs[k]}`),
        WorkingDir: convertToPosixPath(evt.node.cwd),
        Labels: { app: 'hammerkit', 'hammerkit-id': evt.node.id, 'hammerkit-type': 'task' },
        HostConfig: {
          Binds: [
            ...mounts.map((v) => `${v.localPath}:${convertToPosixPath(v.containerPath)}`),
            ...volumes.map((v) => `${v.name}:${convertToPosixPath(v.containerPath)}`),
          ],
          PortBindings: evt.node.ports.reduce<{ [key: string]: { HostPort: string }[] }>((map, port) => {
            map[`${port.containerPort}/tcp`] = [{ HostPort: `${port.hostPort}` }]
            return map
          }, {}),
          Links: links,
          AutoRemove: true,
        },
        ExposedPorts: evt.node.ports.reduce<{ [key: string]: Record<string, unknown> }>((map, port) => {
          map[`${port.containerPort}/tcp`] = {}
          return map
        }, {}),
      })

      const user =
        platform() === 'linux' || platform() === 'freebsd' || platform() === 'openbsd' || platform() === 'sunos'
          ? `${process.getuid()}:${process.getgid()}`
          : undefined

      for (const mount of mounts) {
        evt.node.status.write('debug', `bind mount ${mount.localPath}:${mount.containerPath}`)
      }
      for (const volume of volumes) {
        evt.node.status.write('debug', `volume mount ${volume.name}:${volume.containerPath}`)
      }

      evt.node.status.write('debug', `starting container with image ${evt.node.image}`)
      await startContainer(evt.node, container)

      if (user) {
        const setUserPermission = async (directory: string) => {
          evt.node.status.write('debug', `set permission on ${directory}`)
          const result = await execCommand(
            evt.node,
            docker,
            container!,
            '/',
            ['chown', user, directory],
            undefined,
            undefined
          )
          if (result.type === 'timeout' || result.result.ExitCode !== 0) {
            evt.node.status.write('warn', `unable to set permissions for ${directory}`)
          }
        }

        await setUserPermission(evt.node.cwd)
        for (const volume of volumes) {
          await setUserPermission(volume.containerPath)
        }
        for (const mount of mounts) {
          await setUserPermission(mount.containerPath)
        }
      }

      for (const cmd of evt.node.cmds) {
        checkForAbort(evt.abortSignal)

        const command = templateValue(cmd.cmd, evt.node.envs)
        evt.node.status.write('info', `execute cmd ${command} in container`)

        const result = await execCommand(
          evt.node,
          docker,
          container,
          convertToPosixPath(cmd.path),
          [evt.node.shell, '-c', command],
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
          await eventBus.emit({
            type: 'node-abort',
            node: evt.node,
            command,
            exitCode: result.result.ExitCode ?? 1,
          })
          return
        }
      }
      await eventBus.emit({
        type: 'node-completed',
        node: evt.node,
      })
    } catch (e) {
      if (e instanceof AbortError) {
        await eventBus.emit({
          type: 'node-canceled',
          node: evt.node,
        })
      } else {
        await eventBus.emit({
          type: 'node-crash',
          node: evt.node,
          errorMessage: getErrorMessage(e),
        })
      }
    } finally {
      if (container) {
        try {
          await removeContainer(container)
        } catch (e) {
          evt.node.status.write('error', `remove of container failed ${getErrorMessage(e)}`)
        }
      }
    }
  })

  eventBus.on<SchedulerStartServiceEvent>('scheduler-start-service', async (evt) => {
    let container: Container | null = null

    try {
      checkForAbort(evt.abortSignal)

      const docker = await getDocker(evt.service)
      await pull(evt.service, docker, evt.service.image)

      checkForAbort(evt.abortSignal)
      evt.service.status.write('debug', `create container with image ${evt.service.image}`)
      container = await docker.createContainer({
        Image: evt.service.image,
        Env: Object.keys(evt.service.envs).map((k) => `${k}=${evt.service.envs[k]}`),
        Labels: { app: 'hammerkit', 'hammerkit-id': evt.service.id, 'hammerkit-type': 'service' },
        ExposedPorts: evt.service.ports.reduce<{ [key: string]: Record<string, unknown> }>((map, port) => {
          map[`${port.containerPort}/tcp`] = {}
          return map
        }, {}),
        HostConfig: {
          PortBindings: evt.service.ports.reduce<{ [key: string]: { HostPort: string }[] }>((map, port) => {
            map[`${port.containerPort}/tcp`] = [{ HostPort: `${port.hostPort}` }]
            return map
          }, {}),
        },
      })

      const stream = await container.attach({ stream: true, stdout: true, stderr: true })
      logStream(evt.service, docker, stream)

      await container.start()

      const info = await container.inspect()
      const containerName = info.Name

      if (!evt.service.healthcheck) {
        await eventBus.emit({
          type: 'service-ready',
          service: evt.service,
          containerId: container!.id,
        })
      } else {
        checkReadiness(containerName, evt.service.healthcheck)
      }

      async function checkReadiness(containerName: string, healthCheck: ExecutionBuildServiceHealthCheck) {
        try {
          const result = await execCommand(
            evt.service,
            docker,
            container!,
            undefined,
            healthCheck.cmd.split(' '),
            undefined,
            2000
          )

          if (result.type === 'timeout') {
            setTimeout(() => checkReadiness(containerName, healthCheck), 3000)
            return
          } else {
            if (result.result.ExitCode === 0) {
              evt.service.status.write('debug', `healthcheck ${healthCheck.cmd} succeeded`)
              await eventBus.emit({
                type: 'service-ready',
                service: evt.service,
                containerId: container!.id,
              })
            } else {
              evt.service.status.write('debug', `healthcheck ${healthCheck.cmd} failed with ${result.result.ExitCode}`)
              setTimeout(() => checkReadiness(containerName, healthCheck), 5000)
            }
          }
        } catch (e) {
          evt.service.status.write('debug', `checking readiness failed ${getErrorMessage(e)}`)
          setTimeout(() => checkReadiness(containerName, healthCheck), 5000)
        }
      }
    } catch (e) {
      if (e instanceof AbortError) {
        await eventBus.emit({
          type: 'service-cancelled',
          service: evt.service,
        })
      } else {
        await eventBus.emit({
          type: 'service-crash',
          service: evt.service,
          errorMessage: getErrorMessage(e),
        })
      }
    } finally {
      if (container) {
        try {
          await removeContainer(container)
        } catch (e) {
          evt.service.status.write('error', `remove of container failed ${getErrorMessage(e)}`)
        }
      }
    }
  })
}
