import { KubernetesWorkService } from '../planner/work-service'
import { Process } from './emitter'
import { HammerkitEvent, ServiceCanceledEvent, ServiceCrashEvent, ServiceReadyEvent } from './events'
import { exec } from 'child_process'
import { getErrorMessage, getLogs } from '../log'
import { listenOnAbort, waitOnAbort } from '../utils/abort-event'

export function kubernetesService(
  service: KubernetesWorkService
): Process<ServiceReadyEvent | ServiceCanceledEvent | ServiceCrashEvent, HammerkitEvent> {
  return async (abort, emitter) => {
    const cmd = `kubectl port-forward ${service.selector.type}/${service.selector.name} --context ${
      service.context
    } ${service.ports.map((p) => `${p.hostPort}:${p.containerPort}`).join(' ')}`
    const ps = exec(cmd, {})
    ps.stdout?.on('data', async (data) => {
      for (const log of getLogs(data)) {
        service.console.write('stdout', log)
      }
      // TODO parse content, only emit once
      emitter.emit({
        type: 'service-ready',
        service,
        dns: { host: 'host-gateway' },
      })
    })
    ps.stderr?.on('data', async (data) => {
      for (const log of getLogs(data)) {
        service.console.write('stderr', log)
      }
    })
    ps.on('error', (err) => {
      // TODO end task
      emitter.emit({
        type: 'service-crash',
        service,
        errorMessage: getErrorMessage(err),
      })
    })
    ps.on('close', (code) => {
      // TODO
      emitter.emit({
        type: 'service-crash',
        service,
        errorMessage: getErrorMessage(code),
      })
    })

    await waitOnAbort(abort)

    ps.kill()

    return {
      type: 'service-canceled',
      service: service,
    }
  }
}
