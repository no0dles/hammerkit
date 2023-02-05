import { SchedulerState } from './scheduler/scheduler-state'
import { State } from './state'
import { ProcessManager } from './process-manager'
import { Environment } from './environment'
import { getServiceContainers } from './get-service-containers'
import { dockerService } from './docker-service'
import { kubernetesService } from './kubernetes-service'
import { isContainerWorkServiceItem, isKubernetesWorkServiceItem } from '../planner/work-item'

export function scheduleReadyServices(
  currentState: SchedulerState,
  state: State,
  processManager: ProcessManager,
  environment: Environment
) {
  for (const [_, serviceState] of Object.entries(currentState.service)) {
    const hasOpenDeps = serviceState.service.deps.some((dep) => currentState.node[dep.id].type !== 'completed')
    if (hasOpenDeps) {
      continue
    }

    if (serviceState.type === 'ready') {
      state.patchService({
        type: 'starting',
        service: serviceState.service,
        stateKey: serviceState.stateKey,
        itemId: serviceState.itemId,
      })

      const serviceContainers = getServiceContainers(currentState, serviceState.service.needs)
      if (isContainerWorkServiceItem(serviceState.service)) {
        processManager.background(
          serviceState.service,
          dockerService(serviceState.service, serviceState.stateKey, serviceContainers, state, environment),
          'service'
        )
      } else if (isKubernetesWorkServiceItem(serviceState.service)) {
        processManager.background(
          serviceState.service,
          kubernetesService(serviceState.service, serviceState.stateKey, state),
          'service'
        )
      }
    }
  }
}
