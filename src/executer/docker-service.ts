import { ContainerWorkService } from '../planner/work-service'
import Dockerode, { Container } from 'dockerode'
import { AbortError, checkForAbort } from './abort'
import { convertToPosixPath } from './execute-docker'
import { logStream } from '../docker/stream'
import { waitOnAbort } from '../utils/abort-event'
import { getErrorMessage } from '../log'
import { removeContainer } from '../docker/remove-container'
import { checkReadiness } from './check-readiness'
import { Environment } from './environment'
import { prepareMounts, prepareVolume, pullImage } from './execution-steps'
import { getNeedsNetwork } from './docker-task'
import { WorkItem } from '../planner/work-item'
import { ServiceState } from './scheduler/service-state'
import { getEnvironmentVariables } from '../environment/replace-env-variables'
import { ExecuteOptions } from '../runtime/runtime'
import { getServiceContainers } from './get-service-containers'

export async function dockerService(
  docker: Dockerode,
  item: WorkItem<ContainerWorkService>,
  options: ExecuteOptions<ServiceState>,
  environment: Environment
): Promise<void> {
  let container: Container | null = null

  try {
    await prepareMounts(item, environment)
    checkForAbort(options.abort)

    await pullImage(item, docker)
    checkForAbort(options.abort)

    await prepareVolume(item, docker)
    checkForAbort(options.abort)

    const serviceContainers = getServiceContainers(item.needs)
    const network = getNeedsNetwork(serviceContainers, item.needs)

    item.status.write('debug', `create container with image ${item.data.image}`)
    const envs = getEnvironmentVariables(item.data.envs)
    container = await docker.createContainer({
      Image: item.data.image,
      Env: Object.keys(envs).map((k) => `${k}=${envs[k]}`),
      Labels: {
        app: 'hammerkit',
        'hammerkit-id': item.id(),
        'hammerkit-pid': process.pid.toString(),
        'hammerkit-type': 'service',
        'hammerkit-state': options.stateKey,
      },
      ExposedPorts: item.data.ports.reduce<{ [key: string]: Record<string, unknown> }>((map, port) => {
        map[`${port.containerPort}/tcp`] = {}
        return map
      }, {}),
      Cmd: item.data.cmd ? [item.data.cmd.parsed.command, ...item.data.cmd.parsed.args] : undefined,
      WorkingDir: item.data.cwd ? convertToPosixPath(item.data.cwd) : undefined,
      HostConfig: {
        ExtraHosts: network.hosts,
        Links: network.links,
        Binds: [
          ...item.data.src.map((s) => `${s.absolutePath}:${s.absolutePath}`),
          ...item.data.mounts.map((v) => `${v.localPath}:${convertToPosixPath(v.containerPath)}`),
          ...item.data.volumes.map((v) => `${v.name}:${convertToPosixPath(v.containerPath)}`),
        ],
        PortBindings: item.data.ports
          .filter((p) => !!p.hostPort)
          .reduce<{ [key: string]: { HostPort: string }[] }>((map, port) => {
            map[`${port.containerPort}/tcp`] = [{ HostPort: `${port.hostPort}` }]
            return map
          }, {}),
      },
    })

    const stream = await container.attach({ stream: true, stdout: true, stderr: true })
    logStream(item.status, stream)

    await container.start()

    if (!item.data.healthcheck) {
      options.state.set({
        type: 'running',
        dns: { containerId: container.id },
        stateKey: options.stateKey,
        remote: null,
      })
    } else {
      let ready = false
      do {
        ready = await checkReadiness(item.status, item.data.healthcheck, environment, container, options.abort)
        if (!ready) {
          await new Promise<void>((resolve) => setTimeout(() => resolve(), 1000))
        }
      } while (!ready && !options.abort.aborted)

      if (ready) {
        options.state.set({
          type: 'running',
          dns: { containerId: container.id },
          stateKey: options.stateKey,
          remote: null,
        })
      }
    }

    // TODO check if container crashes
    if (!options.daemon) {
      await waitOnAbort(options.abort)

      options.state.set({
        type: 'end',
        stateKey: options.stateKey,
        reason: 'terminated',
      })
    }
  } catch (e) {
    if (e instanceof AbortError) {
      options.state.set({
        type: 'canceled',
        stateKey: options.stateKey,
      })
    } else {
      item.status.write('error', getErrorMessage(e))
      options.state.set({
        type: 'end',
        reason: 'crash',
        stateKey: options.stateKey,
      })
    }
  } finally {
    if (container && !options.daemon) {
      try {
        await removeContainer(container)
      } catch (e) {
        item.status.write('error', `remove of container failed ${getErrorMessage(e)}`)
      }
    }
  }
}
