import { ServiceState } from './scheduler/service-state'
import { ProcessManager } from './process-manager'
import { State } from './state'
import { Environment } from './environment'
import { SchedulerState } from './scheduler/scheduler-state'
import { getServiceContainers } from './get-service-containers'
import { startService } from './start-node'
import { ensureNeeds } from './ensure-needs'

export function schedulePendingServices(
  services: ServiceState[],
  state: State,
  processManager: ProcessManager,
  environment: Environment,
  currentState: SchedulerState
) {
  for (const service of services) {
    if (service.type !== 'pending') {
      continue
    }

    if (!ensureNeeds(service, service.service.needs, processManager, state, environment, currentState)) {
      continue
    }

    state.patchService({
      type: 'starting',
      service: service.service,
      stateKey: null,
    })

    const serviceContainers = getServiceContainers(currentState, service.service.needs)

    processManager.background(
      {
        type: 'service',
        name: service.service.name,
        id: service.service.id + '-cache',
      },
      async (abort) => {
        await startService(service.service, state, serviceContainers, environment, abort.signal)
      }
    )
  }
}
