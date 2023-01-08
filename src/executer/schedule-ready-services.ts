import { SchedulerState } from './scheduler/scheduler-state'
import { State } from './state'
import { ProcessManager } from './process-manager'
import { Environment } from './environment'
import { logContext } from '../planner/work-node-status'
import { getServiceContainers } from './get-service-containers'
import { isContainerWorkService } from '../planner/work-service'
import { dockerService } from './docker-service'
import { kubernetesService } from './kubernetes-service'

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
      const ctx = logContext('service', serviceState.service)
      state.patchService({
        type: 'starting',
        service: serviceState.service,
        stateKey: serviceState.stateKey,
      })

      const serviceContainers = getServiceContainers(currentState, serviceState.service.needs)
      processManager.background(
        ctx,
        isContainerWorkService(serviceState.service)
          ? dockerService(serviceState.service, serviceState.stateKey, serviceContainers, state, environment)
          : kubernetesService(serviceState.service, serviceState.stateKey, state, environment)
      )
    }
  }
}
