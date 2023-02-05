import { ContainerWorkService } from '../planner/work-service'
import { Container } from 'dockerode'
import { AbortError, checkForAbort } from './abort'
import { convertToPosixPath } from './execute-docker'
import { logStream } from '../docker/stream'
import { waitOnAbort } from '../utils/abort-event'
import { getErrorMessage } from '../log'
import { removeContainer } from '../docker/remove-container'
import { checkReadiness } from './check-readiness'
import { Environment } from './environment'
import { State } from './state'
import { Process } from './process'
import { prepareMounts, prepareVolume, pullImage } from './execution-steps'
import { getNeedsNetwork } from './docker-node'
import { ServiceDns } from './service-dns'
import { WorkItem } from '../planner/work-item'

export function dockerService(
  item: WorkItem<ContainerWorkService>,
  stateKey: string,
  serviceContainers: { [key: string]: ServiceDns },
  state: State,
  environment: Environment
): Process {
  return async (abort) => {
    let container: Container | null = null

    await prepareMounts(item, environment)
    checkForAbort(abort.signal)

    await pullImage(item, environment)
    checkForAbort(abort.signal)

    await prepareVolume(item, environment)
    checkForAbort(abort.signal)

    try {
      checkForAbort(abort.signal)

      const network = getNeedsNetwork(serviceContainers, item.needs)

      item.status.write('debug', `create container with image ${item.data.image}`)
      container = await environment.docker.createContainer({
        Image: item.data.image,
        Env: Object.keys(item.data.envs).map((k) => `${k}=${item.data.envs[k]}`),
        Labels: {
          app: 'hammerkit',
          'hammerkit-id': item.id,
          'hammerkit-pid': process.pid.toString(),
          'hammerkit-type': 'service',
          'hammerkit-state': stateKey,
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
            ...item.data.mounts.map((v) => `${v.localPath}:${convertToPosixPath(v.containerPath)}`),
            ...item.data.volumes.map((v) => `${v.name}:${convertToPosixPath(v.containerPath)}`),
          ],
          PortBindings: item.data.ports.reduce<{ [key: string]: { HostPort: string }[] }>((map, port) => {
            map[`${port.containerPort}/tcp`] = [{ HostPort: `${port.hostPort}` }]
            return map
          }, {}),
        },
      })

      const stream = await container.attach({ stream: true, stdout: true, stderr: true })
      logStream(item.status, stream)

      await container.start()

      if (!item.data.healthcheck) {
        state.patchService({
          type: 'running',
          service: item,
          dns: { containerId: container.id },
          stateKey,
          remote: null,
          itemId: item.id,
        })
      } else {
        let ready = false
        do {
          ready = await checkReadiness(item.status, item.data.healthcheck, environment, container, abort.signal)
          if (!ready) {
            await new Promise<void>((resolve) => setTimeout(() => resolve(), 1000))
          }
        } while (!ready && !abort.signal.aborted)

        if (ready) {
          state.patchService({
            type: 'running',
            service: item,
            dns: { containerId: container.id },
            stateKey,
            remote: null,
            itemId: item.id,
          })
        }
      }

      if (!state.current.daemon) {
        await waitOnAbort(abort.signal)

        state.patchService({
          type: 'end',
          service: item,
          itemId: item.id,
          stateKey,
          reason: 'terminated',
        })
      }
    } catch (e) {
      if (e instanceof AbortError) {
        state.patchService({
          type: 'canceled',
          service: item,
          itemId: item.id,
          stateKey,
        })
      } else {
        item.status.write('error', getErrorMessage(e))
        state.patchService({
          type: 'end',
          service: item,
          itemId: item.id,
          reason: 'crash',
          stateKey,
        })
      }
    } finally {
      if (container && !state.current.daemon) {
        try {
          await removeContainer(container)
        } catch (e) {
          item.status.write('error', `remove of container failed ${getErrorMessage(e)}`)
        }
      }
    }
  }
}
