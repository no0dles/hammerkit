import { KubernetesWorkService } from '../planner/work-service'
import { exec } from 'child_process'
import { getErrorMessage, getLogs } from '../log'
import { waitOnAbort } from '../utils/abort-event'
import { Environment } from './environment'
import { State } from './state'
import { Process } from './process'

export function kubernetesService(service: KubernetesWorkService, state: State, env: Environment): Process {
  return async (abort) => {
    const status = env.status.service(service)
    const cmd = `kubectl port-forward ${service.selector.type}/${service.selector.name} --kubeconfig ${
      service.kubeconfig
    } --context ${service.context} ${service.ports.map((p) => `${p.hostPort}:${p.containerPort}`).join(' ')}`
    const ps = exec(cmd, {})
    ps.stdout?.on('data', async (data) => {
      for (const log of getLogs(data)) {
        status.console('stdout', log)
      }
      // TODO parse content
      const currentState = state.current.service[service.id]
      if (currentState.type === 'running') {
        state.patchService({
          service,
          abortController: currentState.abortController,
          type: 'ready',
          dns: { host: 'host-gateway' },
        })
      }
    })
    ps.stderr?.on('data', async (data) => {
      for (const log of getLogs(data)) {
        status.console('stderr', log)
      }
    })
    ps.on('error', (err) => {
      status.write('error', getErrorMessage(err))
      state.patchService({
        service,
        type: 'end',
        reason: 'crash',
      })
    })
    ps.on('close', (code) => {
      status.write('info', `exit with ${code}`)
      state.patchService({
        service,
        type: 'end',
        reason: 'crash',
      })
    })

    await waitOnAbort(abort.signal)

    ps.kill()
  }
}