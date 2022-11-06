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
import { prepareMounts, prepareVolume, pullImage, setUserPermissions } from './execution-steps'

export function dockerService(
  service: ContainerWorkService,
  stateKey: string,
  state: State,
  environment: Environment
): Process {
  return async (abort) => {
    const status = environment.status.service(service)
    let container: Container | null = null

    await prepareMounts(service, environment)
    checkForAbort(abort.signal)

    await pullImage(service, environment)
    checkForAbort(abort.signal)

    await prepareVolume(service, environment)
    checkForAbort(abort.signal)

    try {
      checkForAbort(abort.signal)
      status.write('debug', `create container with image ${service.image}`)
      container = await environment.docker.createContainer({
        Image: service.image,
        Env: Object.keys(service.envs).map((k) => `${k}=${service.envs[k]}`),
        Labels: { app: 'hammerkit', 'hammerkit-id': service.id, 'hammerkit-type': 'service' },
        ExposedPorts: service.ports.reduce<{ [key: string]: Record<string, unknown> }>((map, port) => {
          map[`${port.containerPort}/tcp`] = {}
          return map
        }, {}),
        Cmd: service.cmd ? service.cmd.split(' ') : undefined,
        HostConfig: {
          Binds: [
            ...service.mounts.map((v) => `${v.localPath}:${convertToPosixPath(v.containerPath)}`),
            ...service.volumes.map((v) => `${v.name}:${convertToPosixPath(v.containerPath)}`),
          ],
          PortBindings: service.ports.reduce<{ [key: string]: { HostPort: string }[] }>((map, port) => {
            map[`${port.containerPort}/tcp`] = [{ HostPort: `${port.hostPort}` }]
            return map
          }, {}),
        },
      })

      const stream = await container.attach({ stream: true, stdout: true, stderr: true })
      logStream(status, stream)

      await container.start()

      await setUserPermissions(service, container, environment)

      if (!service.healthcheck) {
        state.patchService({
          type: 'running',
          service,
          dns: { containerId: container.id },
          stateKey,
        })
      } else {
        let ready = false
        do {
          ready = await checkReadiness(status, service.healthcheck, environment, container, abort.signal)
          if (!ready) {
            await new Promise<void>((resolve) => setTimeout(() => resolve(), 1000))
          }
        } while (!ready && !abort.signal.aborted)

        if (ready) {
          state.patchService({
            type: 'running',
            service,
            dns: { containerId: container.id },
            stateKey,
          })
        }
      }

      await waitOnAbort(abort.signal)

      state.patchService({
        type: 'end',
        service,
        stateKey,
        reason: 'terminated',
      })
    } catch (e) {
      if (e instanceof AbortError) {
        state.patchService({
          type: 'canceled',
          service,
          stateKey,
        })
      } else {
        status.write('error', getErrorMessage(e))
        state.patchService({
          type: 'end',
          service,
          reason: 'crash',
          stateKey,
        })
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
