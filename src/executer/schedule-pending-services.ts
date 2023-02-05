import { ServiceState } from './scheduler/service-state'
import { ProcessManager } from './process-manager'
import { State } from './state'
import { Environment } from './environment'
import { SchedulerState } from './scheduler/scheduler-state'
import { getServiceContainers } from './get-service-containers'
import { startService } from './start-node'
import { ensureNeeds } from './ensure-needs'

export function schedulePendingServices(
  servicesStates: ServiceState[],
  state: State,
  processManager: ProcessManager,
  environment: Environment,
  currentState: SchedulerState
) {
  for (const serviceState of servicesStates) {
    if (serviceState.type !== 'pending') {
      continue
    }

    if (!ensureNeeds(serviceState, serviceState.service.needs, processManager, state, environment, currentState)) {
      continue
    }

    state.patchService({
      type: 'starting',
      service: serviceState.service,
      stateKey: null,
      itemId: serviceState.itemId,
    })

    const serviceContainers = getServiceContainers(currentState, serviceState.service.needs)

    processManager.background(
      serviceState.service,
      async (abort) => {
        await startService(serviceState.service, state, serviceContainers, environment, abort.signal)
      },
      'cache'
    )
  }
}
