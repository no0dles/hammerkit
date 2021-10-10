import { Executor, ServiceProcess } from './executor'
import { isContainerWorkNode, WorkNode } from '../planner/work-node'
import { ExecutionContext } from './execution-context'
import { checkIfAbort, execCommand, executeDocker, generateId, getDocker, getVolumeName } from './execute-docker'
import { getLocalExecutor } from './get-local-executor'
import { replaceEnvVariables } from '../environment/replace-env-variables'
import { join } from 'path'
import { Environment } from './environment'
import Dockerode, { Container, VolumeInspectInfo } from 'dockerode'
import { WorkService } from '../planner/work-service'
import { pull } from '../docker/pull'
import { listenOnAbort } from '../utils/abort-event'
import { WorkTree } from '../planner/work-tree'
import { serviceReady, serviceRunning } from './states'
import { ExecutionBuildServiceHealthCheck } from '../parser/build-file-service'
import { logMessageToConsole } from '../logging/message-to-console'
import { getErrorMessage } from '../log'
import { WorkNodes } from '../planner/work-nodes'
import { WorkServices } from '../planner/work-services'
import { removeContainer } from '../docker/remove-container'

export async function existsVolume(docker: Dockerode, volumeName: string): Promise<VolumeInspectInfo | false> {
  try {
    const volume = await docker.getVolume(volumeName)
    return await volume.inspect()
  } catch (e) {
    return false
  }
}

export async function ensureVolumeExists(docker: Dockerode, volumeName: string): Promise<void> {
  const volumeExists = await existsVolume(docker, volumeName)
  if (!volumeExists) {
    await docker.createVolume({
      Name: volumeName,
      Driver: 'local',
      Labels: { app: 'hammerkit' },
    })
  }
}

export async function getDockerExecutor(): Promise<Executor> {
  const localExec = getLocalExecutor()
  const docker = getDocker()

  try {
    await docker.version()
  } catch (e) {
    if (e instanceof Error && e.message.indexOf('ECONNREFUSED') >= 0) {
      logMessageToConsole(
        {
          message: `docker is not running, try running in local shell or start`,
          type: 'internal',
          date: new Date(),
          level: 'error',
        },
        { type: 'general' }
      )
    }

    throw e
  }

  return {
    start(workTree: WorkTree, service: WorkService, context: ExecutionContext): ServiceProcess {
      service.status.console.write('internal', 'debug', `execute ${service.name} as docker service`)

      let container: Container

      async function run() {
        checkIfAbort(context.environment.abortCtrl)
        await pull(service.status.console, docker, service.image)

        service.status.console.write('internal', 'debug', `create container with image ${service.image}`)
        container = await docker.createContainer({
          Image: service.image,
          Env: Object.keys(service.envs).map((k) => `${k}=${service.envs[k]}`),
          Labels: { app: 'hammerkit', 'hammerkit-id': service.id, 'hammerkit-type': 'service' },
          ExposedPorts: service.ports.reduce<{ [key: string]: Record<string, unknown> }>((map, port) => {
            map[`${port.containerPort}/tcp`] = {}
            return map
          }, {}),
          HostConfig: {
            PortBindings: service.ports.reduce<{ [key: string]: { HostPort: string }[] }>((map, port) => {
              map[`${port.containerPort}/tcp`] = [{ HostPort: `${port.hostPort}` }]
              return map
            }, {}),
          },
        })

        await container.start()

        listenOnAbort(context.environment.abortCtrl.signal, async () => {
          try {
            await removeContainer(container)
          } catch (e) {
            service.status.console.write('internal', 'debug', `failed to remove container: ${getErrorMessage(e)}`)
          }
        })

        const info = await container.inspect()
        const containerName = info.Name

        serviceRunning(workTree, service.id, context, containerName)

        if (!service.healthcheck) {
          serviceReady(workTree, service.id, context, containerName)
        } else {
          checkReadiness(containerName, service.healthcheck)
        }
      }

      async function checkReadiness(containerName: string, healthCheck: ExecutionBuildServiceHealthCheck) {
        try {
          const result = await execCommand(
            service.status.console,
            docker,
            container,
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
              service.status.console.write('internal', 'debug', `healthcheck ${healthCheck.cmd} succeeded`)
              serviceReady(workTree, service.id, context, containerName)
            } else {
              service.status.console.write(
                'internal',
                'debug',
                `healthcheck ${healthCheck.cmd} failed with ${result.result.ExitCode}`
              )
              setTimeout(() => checkReadiness(containerName, healthCheck), 5000)
            }
          }
        } catch (e) {
          service.status.console.write('internal', 'debug', `checking readiness failed ${getErrorMessage(e)}`)
          setTimeout(() => checkReadiness(containerName, healthCheck), 5000)
        }
      }

      run().catch((e) => {
        service.status.console.write('internal', 'error', `service ${service.name} failed with ${getErrorMessage(e)}`)
      })

      return {
        name: service.name,
        async stop() {
          if (container) {
            try {
              await removeContainer(container)
            } catch (e) {
              service.status.console.write('internal', 'debug', `failed to remove container: ${getErrorMessage(e)}`)
            }
          }
        },
      }
    },
    async restore(node: WorkNode, environment: Environment, path: string): Promise<void> {
      const docker = getDocker()
      for (const generate of node.generates) {
        if (generate.inherited) {
          continue
        }

        const id = generateId(generate.path)
        const volumeName = getVolumeName(generate.path)

        const sourcePath = join(path, 'generates', `${id}.tar`)
        if (!(await environment.file.exists(sourcePath))) {
          continue
        }

        await ensureVolumeExists(docker, volumeName)

        node.status.console.write('internal', 'info', `import data into volume ${volumeName}`)
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
    },
    async store(node: WorkNode, environment: Environment, path: string): Promise<void> {
      const docker = getDocker()
      for (const generate of node.generates) {
        if (generate.inherited) {
          continue
        }

        const id = generateId(generate.path)
        const volumeName = getVolumeName(generate.path)

        const volumeExists = await existsVolume(docker, volumeName)
        if (!volumeExists) {
          node.status.console.write('internal', 'info', `generate ${generate} has no volume ${volumeName}`)
          continue
        }

        const targetPath = join(path, 'generates')
        await environment.file.createDirectory(targetPath)
        node.status.console.write('internal', 'info', `export data from volume ${volumeName}`)
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
    },
    async clean(node: WorkNode, environment: Environment): Promise<void> {
      if (!isContainerWorkNode(node)) {
        return localExec.clean(node, environment)
      }

      const docker = getDocker()
      for (const generate of node.generates) {
        if (generate.inherited) {
          continue
        }

        const volumeName = getVolumeName(generate.path)
        const volumeExists = await existsVolume(docker, volumeName)
        if (volumeExists) {
          node.status.console.write('internal', 'info', `remove volume ${volumeName}`)
          const volume = await docker.getVolume(volumeName)
          await volume.remove()
        } else {
          node.status.console.write('internal', 'info', `generate ${generate} has no volume ${volumeName}`)
        }
      }
    },
    async prepareRun(workNodes: WorkNodes, workServices: WorkServices): Promise<void> {
      const containers = await docker.listContainers({})
      for (const container of containers) {
        const containerId = container.Labels['hammerkit-id']
        const containerType = container.Labels['hammerkit-type']
        if (containerType === 'service') {
          if (workServices[containerId]) {
            await docker.getContainer(container.Id).remove({ force: true })
          }
        } else if (containerType === 'task') {
          if (workNodes[containerId]) {
            await docker.getContainer(container.Id).remove({ force: true })
          }
        }
      }
    },
    async exec(node: WorkNode, context: ExecutionContext, abortCtrl: AbortController): Promise<void> {
      if (!isContainerWorkNode(node)) {
        return localExec.exec(node, context, abortCtrl)
      }

      const envs = replaceEnvVariables(node, context.environment.processEnvs)
      await executeDocker(
        {
          ...node,
          envs,
        },
        context,
        abortCtrl
      )
    },
  }
}
