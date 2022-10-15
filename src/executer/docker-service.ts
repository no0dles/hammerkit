import { ContainerWorkService } from '../planner/work-service'
import { Container } from 'dockerode'
import { AbortError, checkForAbort } from './abort'
import { getDocker } from './execute-docker'
import { pull } from '../docker/pull'
import { logStream } from '../docker/stream'
import { waitOnAbort } from '../utils/abort-event'
import { getErrorMessage } from '../log'
import { removeContainer } from '../docker/remove-container'
import { checkReadiness } from './check-readiness'
import { Environment } from './environment'
import { State } from './state'
import { Process } from './process'

export function dockerService(service: ContainerWorkService, state: State, environment: Environment): Process {
  return async (abort) => {
    const status = environment.status.service(service)
    let container: Container | null = null

    try {
      checkForAbort(abort)

      const docker = await getDocker(status)
      await pull(status, docker, service.image)

      checkForAbort(abort)
      status.write('debug', `create container with image ${service.image}`)
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
      logStream(status, docker, stream)

      await container.start()

      if (!service.healthcheck) {
        const currentState = state.current.service[service.id]
        if (currentState.type === 'running') {
          state.patchService({
            type: 'ready',
            service,
            dns: { containerId: container.id },
            abortController: currentState.abortController,
          })
        }
      } else {
        let ready = false
        do {
          ready = await checkReadiness(status, service.healthcheck, docker, container, abort)
          if (!ready) {
            await new Promise<void>((resolve) => setTimeout(() => resolve(), 1000))
          }
        } while (!ready)

        const currentState = state.current.service[service.id]
        if (currentState.type === 'running') {
          state.patchService({
            type: 'ready',
            service,
            dns: { containerId: container.id },
            abortController: currentState.abortController,
          })
        }
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
          status.write('error', `remove of container failed ${getErrorMessage(e)}`)
        }
      }
    }
  }
}
