import { KubernetesWorkService } from '../planner/work-service'
import { exec } from 'child_process'
import { getErrorMessage, getLogs } from '../log'
import { listenOnAbort } from '../utils/abort-event'
import { Environment } from './environment'
import { State } from './state'
import { Process } from './process'
import { StatusScopedConsole } from '../planner/work-node-status'
import { sleep } from '../utils/sleep'

export function kubernetesService(
  service: KubernetesWorkService,
  stateKey: string,
  state: State,
  env: Environment
): Process {
  return async (abort) => {
    const status = env.status.service(service)

    do {
      await startForward(service, stateKey, state, status, abort)
      if (!abort.signal.aborted) {
        await sleep(1000)
      }
    } while (!abort.signal.aborted)
  }
}

function startForward(
  service: KubernetesWorkService,
  stateKey: string,
  state: State,
  status: StatusScopedConsole,
  abort: AbortController
) {
  const cmd = `kubectl port-forward ${service.selector.type}/${service.selector.name} --kubeconfig ${
    service.kubeconfig
  } --context ${service.context} ${service.ports.map((p) => `${p.hostPort}:${p.containerPort}`).join(' ')}`

  const ps = exec(cmd, {})

  return new Promise<void>((resolve) => {
    ps.stdout?.on('data', async (data) => {
      for (const log of getLogs(data)) {
        status.console('stdout', log)
      }
      state.patchService({
        service,
        type: 'running',
        dns: { host: 'host-gateway' },
        stateKey,
        remote: null,
      })
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
        stateKey,
      })
    })
    ps.on('close', (code) => {
      status.write('info', `exit with ${code}`)
      state.patchService({
        service,
        type: 'end',
        reason: 'crash',
        stateKey,
      })
      resolve()
    })
  })

  listenOnAbort(abort.signal, () => {
    ps.kill()
  })
}
