import { ContainerWorkService, WorkService } from '../planner/work-service'
import { Process } from './emitter'
import { HammerkitEvent, ServiceCanceledEvent, ServiceCrashEvent, ServiceReadyEvent } from './events'
import { Container } from 'dockerode'
import { AbortError, checkForAbort } from './abort'
import { getDocker } from './execute-docker'
import { pull } from '../docker/pull'
import { logStream } from '../docker/stream'
import { waitOnAbort } from '../utils/abort-event'
import { getErrorMessage } from '../log'
import { removeContainer } from '../docker/remove-container'
import { checkReadiness } from './check-readiness'

export function dockerService(
  service: ContainerWorkService
): Process<ServiceReadyEvent | ServiceCanceledEvent | ServiceCrashEvent, HammerkitEvent> {
  return async (abort, emitter) => {
    let container: Container | null = null

    try {
      checkForAbort(abort)

      const docker = await getDocker(service)
      await pull(service, docker, service.image)

      checkForAbort(abort)
      service.status.write('debug', `create container with image ${service.image}`)
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

      const stream = await container.attach({ stream: true, stdout: true, stderr: true })
      logStream(service, docker, stream)

      await container.start()

      if (!service.healthcheck) {
        emitter.emit({
          type: 'service-ready',
          service: service,
          dns: { containerId: container.id },
        })
      } else {
        let ready = false
        do {
          ready = await checkReadiness(service, service.healthcheck, docker, container, abort)
          if (!ready) {
            await new Promise<void>((resolve) => setTimeout(() => resolve(), 1000))
          }
        } while (!ready)

        emitter.emit({
          type: 'service-ready',
          service,
          dns: { containerId: container.id },
        })
      }

      await waitOnAbort(abort)

      return {
        type: 'service-canceled',
        service: service,
      }
    } catch (e) {
      if (e instanceof AbortError) {
        return {
          type: 'service-canceled',
          service: service,
        }
      } else {
        return {
          type: 'service-crash',
          service,
          errorMessage: getErrorMessage(e),
        }
      }
    } finally {
      if (container) {
        try {
          await removeContainer(container)
        } catch (e) {
          service.status.write('error', `remove of container failed ${getErrorMessage(e)}`)
        }
      }
    }
  }
}
