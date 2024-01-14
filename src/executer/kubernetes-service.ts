import { exec } from 'child_process'
import { getErrorMessage, getLogs } from '../log'
import { listenOnAbort } from '../utils/abort-event'
import { sleep } from '../utils/sleep'
import { WorkItem } from '../planner/work-item'
import { KubernetesWorkService } from '../planner/work-service'
import { ServiceState } from './scheduler/service-state'
import { ExecuteOptions } from '../runtime/runtime'

// TODO change ServiceState => ServiceReadyState
export async function kubernetesService(
  service: WorkItem<KubernetesWorkService>,
  options: ExecuteOptions<ServiceState>
): Promise<void> {
  do {
    await startForward(service, options)
    if (!options.abort.aborted) {
      await sleep(1000)
    }
  } while (!options.abort.aborted)
}

function startForward(item: WorkItem<KubernetesWorkService>, options: ExecuteOptions<ServiceState>) {
  const service = item.data
  const cmd = `kubectl port-forward ${service.selector.type}/${service.selector.name} --kubeconfig ${
    service.kubeconfig
  } --context ${service.context} ${service.ports.map((p) => `${p.hostPort}:${p.containerPort}`).join(' ')}`

  const ps = exec(cmd, {})

  const execution = new Promise<void>((resolve) => {
    ps.stdout?.on('data', async (data) => {
      for (const log of getLogs(data)) {
        item.status.console('stdout', log)
      }
      options.state.set({
        type: 'running',
        dns: { host: 'host-gateway' },
        stateKey: options.stateKey,
        remote: null,
      })
    })
    ps.stderr?.on('data', async (data) => {
      for (const log of getLogs(data)) {
        item.status.console('stderr', log)
      }
    })
    ps.on('error', (err) => {
      item.status.write('error', getErrorMessage(err))
      options.state.set({
        type: 'end',
        reason: 'crash',
        stateKey: options.stateKey,
      })
    })
    ps.on('close', (code) => {
      item.status.write('info', `exit with ${code}`)
      options.state.set({
        type: 'end',
        reason: 'crash',
        stateKey: options.stateKey,
      })
      abortListener.close()
      resolve()
    })
  })

  const abortListener = listenOnAbort(options.abort, () => {
    ps.kill()
  })

  return execution
}
