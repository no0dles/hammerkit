import {
  ContainerWorkService,
  getHealthcheckCommand,
  getServiceCommand,
  getServiceWorkingDir,
} from '../planner/work-service'
import { getRunLabels } from '../docker/run-labels'
import { getServiceHostname } from '../planner/utils/service-hostname'
import { getServiceDefinitionHash } from '../planner/service-definition'
import Dockerode, { Container, ContainerCreateOptions } from 'dockerode'
import { AbortError, checkForAbort } from './abort'
import { convertToPosixPath } from './execute-docker'
import { logStream } from '../docker/stream'
import { listenOnAbort } from '../utils/abort-event'
import { getErrorMessage } from '../log'
import { removeContainer } from '../docker/remove-container'
import { checkReadiness } from './check-readiness'
import { getMainProcessUser } from './main-process-user'
import { Environment } from './environment'
import { prepareMounts, prepareVolume, pullImage } from './execution-steps'
import { dockerTask, getNeedsNetwork } from './docker-task'
import { runServiceInit } from './run-service-init'
import { WorkItem } from '../planner/work-item'
import { ServiceState } from './scheduler/service-state'
import { getEnvironmentVariables } from '../environment/replace-env-variables'
import { ExecuteOptions } from '../runtime/runtime'
import { getServiceContainers } from './get-service-containers'
import { getWorkInstanceId } from '../planner/work-instance-id'
import { getHealthcheckTimeoutMessage } from '../planner/work-healthcheck'

const HEALTHCHECK_INTERVAL_MS = 1000

export function buildServiceCreateOptions(
  item: WorkItem<ContainerWorkService>,
  options: ExecuteOptions<ServiceState>,
  network: { links: string[]; hosts: string[] }
): ContainerCreateOptions {
  const envs = getEnvironmentVariables(item.data.envs)
  const command = getServiceCommand(item.data)
  return {
    Image: item.data.image,
    Hostname: getServiceHostname(item.name),
    Env: Object.keys(envs).map((k) => `${k}=${envs[k]}`),
    Labels: {
      app: 'hammerkit',
      'hammerkit-id': getWorkInstanceId(item),
      ...getRunLabels(),
      'hammerkit-type': 'service',
      'hammerkit-state': options.stateKey,
      'hammerkit-daemon': options.daemon ? 'true' : 'false',
      'hammerkit-definition': getServiceDefinitionHash(item),
    },
    ExposedPorts: item.data.ports.reduce<{ [key: string]: Record<string, unknown> }>((map, port) => {
      map[`${port.containerPort}/tcp`] = {}
      return map
    }, {}),
    Entrypoint: command.entrypoint ?? undefined,
    Cmd: command.cmd ?? undefined,
    WorkingDir: convertToPosixPath(getServiceWorkingDir(item.data)),
    HostConfig: {
      ExtraHosts: network.hosts,
      Links: network.links,
      Binds: [
        ...item.data.src.map((s) => `${s.absolutePath}:${s.absolutePath}`),
        ...item.data.mounts.map(
          (v) => `${v.localPath}:${convertToPosixPath(v.containerPath)}${v.readOnly ? ':ro' : ''}`
        ),
        ...item.data.volumes.map((v) => `${v.name}:${convertToPosixPath(v.containerPath)}${v.readOnly ? ':ro' : ''}`),
      ],
      // host ports are for `hammerkit up` and local tasks; container tasks
      // reach the service over its link, and a run publishing them would
      // collide with another run on the same host
      PortBindings: options.publishPorts
        ? item.data.ports
            .filter((p) => !!p.hostPort)
            .reduce<{ [key: string]: { HostPort: string }[] }>((map, port) => {
              map[`${port.containerPort}/tcp`] = [{ HostPort: `${port.hostPort}` }]
              return map
            }, {})
        : {},
    },
  }
}

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

    await pullImage(item, docker, environment)
    checkForAbort(options.abort)

    await prepareVolume(item, docker)
    checkForAbort(options.abort)

    const serviceContainers = getServiceContainers(item.needs)
    const network = getNeedsNetwork(serviceContainers, item.needs)

    item.status.write('debug', `create container with image ${item.data.image}`)
    container = await docker.createContainer(buildServiceCreateOptions(item, options, network))

    const stream = await container.attach({ stream: true, stdout: true, stderr: true })
    logStream(item.status, stream)

    await container.start()

    const init = item.data.init
    // an init needs a ready service, so a service with one is always awaited
    if (!item.data.healthcheck || (!options.waitForReady && !init)) {
      if (init) {
        await runServiceInit(item, init, { containerId: container.id }, options, (task, taskOptions) =>
          dockerTask(docker, task, environment, taskOptions)
        )
      }
      options.state.set({
        type: 'running',
        dns: { containerId: container.id },
        stateKey: options.stateKey,
        remote: null,
      })
    } else {
      const healthcheck = item.data.healthcheck
      const deadline = Date.now() + healthcheck.timeout
      let ready = false
      do {
        // The first check waits one interval too, so an entrypoint that drops
        // privileges (`exec su-exec app …`) has done so before anything runs.
        await new Promise<void>((resolve) => setTimeout(() => resolve(), HEALTHCHECK_INTERVAL_MS))
        if (options.abort.aborted) {
          break
        }
        const user = await getMainProcessUser(container)
        ready = await checkReadiness(
          item.status,
          getHealthcheckCommand(item.data) ?? [],
          environment,
          container,
          user,
          options.abort
        )
        if (!ready && Date.now() >= deadline) {
          throw new Error(getHealthcheckTimeoutMessage(item.name, healthcheck))
        }
      } while (!ready && !options.abort.aborted)

      if (ready) {
        if (init) {
          await runServiceInit(item, init, { containerId: container.id }, options, (task, taskOptions) =>
            dockerTask(docker, task, environment, taskOptions)
          )
        }
        options.state.set({
          type: 'running',
          dns: { containerId: container.id },
          stateKey: options.stateKey,
          remote: null,
        })
      }
    }

    if (!options.daemon) {
      const reason = await new Promise<'terminated' | 'crash'>((resolve) => {
        const abortHandle = listenOnAbort(options.abort, () => resolve('terminated'))
        container!
          .wait()
          .then(() => {
            abortHandle.close()
            resolve('crash')
          })
          .catch(() => {
            abortHandle.close()
            resolve('crash')
          })
      })

      options.state.set({
        type: 'end',
        stateKey: options.stateKey,
        reason,
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
