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
import { prepareMounts, prepareVolume, pullImage, refuseHostLinks } from './execution-steps'
import {
  ContainerNetworkOptions,
  DockerItemNetwork,
  getNetworkHostConfig,
  prepareItemNetwork,
} from '../docker/item-network'
import { ContainerSecrets, prepareContainerSecrets, removeContainerSecrets } from './container-secrets'
import { WorkItem } from '../planner/work-item'
import { ServiceState } from './scheduler/service-state'
import { getEnvironmentVariables } from '../environment/replace-env-variables'
import { ExecuteOptions } from '../runtime/runtime'
import { getWorkInstanceId } from '../planner/work-instance-id'
import { getHealthcheckTimeoutMessage } from '../planner/work-healthcheck'
import { DockerResources, resolveDockerResources } from './docker-resources'
import { getProxylessEnvironment } from '../network/egress-proxy'

const HEALTHCHECK_INTERVAL_MS = 1000

export function buildServiceCreateOptions(
  item: WorkItem<ContainerWorkService>,
  options: ExecuteOptions<ServiceState>,
  network: ContainerNetworkOptions,
  secrets: ContainerSecrets,
  resources: DockerResources = {}
): ContainerCreateOptions {
  const envs = getEnvironmentVariables(item.data.envs)
  const command = getServiceCommand(item.data)
  return {
    Image: item.data.image,
    Hostname: getServiceHostname(item.name),
    Env: Object.entries({ ...envs, ...network.env, ...secrets.env }).map(([key, value]) => `${key}=${value}`),
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
      ...getNetworkHostConfig(network),
      Binds: [
        ...item.data.src.map((s) => `${s.absolutePath}:${s.absolutePath}`),
        ...item.data.mounts.map(
          (v) => `${v.localPath}:${convertToPosixPath(v.containerPath)}${v.readOnly ? ':ro' : ''}`
        ),
        ...item.data.volumes.map((v) => `${v.name}:${convertToPosixPath(v.containerPath)}${v.readOnly ? ':ro' : ''}`),
        ...secrets.binds,
      ],
      // host ports are for `hammerkit up` and local tasks; container tasks
      // reach the service over its link, and a run publishing them would
      // collide with another run on the same host. A limited service's are
      // published by its relay.
      PortBindings:
        options.publishPorts && !network.relayPorts
          ? item.data.ports
              .filter((p) => !!p.hostPort)
              .reduce<{ [key: string]: { HostPort: string }[] }>((map, port) => {
                map[`${port.containerPort}/tcp`] = [{ HostPort: `${port.hostPort}` }]
                return map
              }, {})
          : {},
      ...resources,
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
  let network: DockerItemNetwork | null = null

  try {
    await prepareMounts(item, environment)
    checkForAbort(options.abort)

    await pullImage(item, docker, environment)
    checkForAbort(options.abort)

    await prepareVolume(item, docker, environment)
    checkForAbort(options.abort)

    network = await prepareItemNetwork(docker, item, environment, {
      daemon: options.daemon,
      publish: options.publishPorts ? item.data.ports : [],
    })
    checkForAbort(options.abort)

    item.status.write('debug', `create container with image ${item.data.image}`)
    const secrets = await prepareContainerSecrets(item.data.secrets, getWorkInstanceId(item), environment)
    const resources = await resolveDockerResources(docker, item.data.resources, item.status)
    await refuseHostLinks(item, environment)
    container = await docker.createContainer(
      buildServiceCreateOptions(item, options, network.options, secrets, resources)
    )
    await network.connect(container)

    const stream = await container.attach({ stream: true, stdout: true, stderr: true })
    logStream(item.status, stream)

    await container.start()

    if (!item.data.healthcheck || !options.waitForReady) {
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
          options.abort,
          getProxylessEnvironment(network.options.env ?? {})
        )
        if (!ready && Date.now() >= deadline) {
          throw new Error(getHealthcheckTimeoutMessage(item.name, healthcheck))
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
    // a daemon keeps its secret files and network until `hammerkit down` stops it
    if (!options.daemon) {
      await removeContainerSecrets(getWorkInstanceId(item))
      if (network) {
        await network
          .release()
          .catch((e) => item.status.write('error', `remove of network failed ${getErrorMessage(e)}`))
      }
    }
  }
}
