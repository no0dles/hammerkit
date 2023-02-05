import { SchedulerState } from './scheduler/scheduler-state'
import { State } from './state'
import { ProcessManager } from './process-manager'
import { Environment } from './environment'
import { hasServiceAnActiveNeed } from './has-service-an-active-need'
import { logContext } from '../planner/work-node-status'
import { removeContainer } from '../docker/remove-container'
import { isContainerWorkService } from '../planner/work-service'
import { getErrorMessage } from '../log'
import { isContainerWorkServiceItem } from '../planner/work-item'

export function unscheduleServices(
  currentState: SchedulerState,
  state: State,
  processManager: ProcessManager,
  environment: Environment,
  force: boolean
) {
  for (const [serviceId, serviceState] of Object.entries(currentState.service)) {
    if (serviceState.type !== 'ready' && serviceState.type !== 'running') {
      continue
    }

    const hasNeed = hasServiceAnActiveNeed(currentState, serviceId)

    if (!force && hasNeed && !environment.abortCtrl.signal.aborted) {
      continue
    }

    serviceState.service.status.write('info', 'stop unused service')
    if (serviceState.type === 'ready' || !serviceState.remote) {
      processManager.abort(serviceState.itemId)
    } else if (isContainerWorkServiceItem(serviceState.service) && serviceState.remote) {
      removeContainer(environment.docker.getContainer(serviceState.remote.containerId))
        .then(() => {
          state.patchService({
            service: serviceState.service,
            type: 'end',
            reason: 'terminated',
            stateKey: serviceState.stateKey,
            itemId: serviceState.itemId,
          })
        })
        .catch((err) => {
          state.patchService({
            service: serviceState.service,
            type: 'error',
            errorMessage: getErrorMessage(err),
            stateKey: serviceState.stateKey,
            itemId: serviceState.itemId,
          })
        })
      state.patchService({
        service: serviceState.service,
        type: 'canceled',
        stateKey: serviceState.stateKey,
        itemId: serviceState.itemId,
      })
    }
  }
}
