import { NodeState } from './scheduler/node-state'
import { isServiceState, ServiceState } from './scheduler/service-state'
import { WorkNeed } from '../planner/work-service'
import { ProcessManager } from './process-manager'
import { State } from './state'
import { Environment } from './environment'
import { SchedulerState } from './scheduler/scheduler-state'
import { schedulePendingServices } from './schedule-pending-services'

export function ensureNeeds(
  nodeOrServiceState: NodeState | ServiceState,
  needs: WorkNeed[],
  processManager: ProcessManager,
  state: State,
  environment: Environment,
  currentState: SchedulerState
): boolean {
  const endedNeeds = needs
    .map((need) => currentState.service[need.service.id])
    .filter((service) => service.type === 'end' || service.type === 'canceled')

  if (endedNeeds.length > 0) {
    if (isServiceState(nodeOrServiceState)) {
      state.patchService({
        type: 'error',
        service: nodeOrServiceState.service,
        stateKey: nodeOrServiceState.stateKey,
        errorMessage: endedNeeds
          .map((n) => `service ${n.service.name} ${n.type === 'end' ? 'has ended ' + n.reason : 'was canceled'}`)
          .join(', '),
      })
    } else {
      state.patchNode(
        {
          type: 'error',
          node: nodeOrServiceState.node,
          stateKey: nodeOrServiceState.stateKey,
          errorMessage: endedNeeds
            .map((n) => `service ${n.service.name} ${n.type === 'end' ? 'has ended ' + n.reason : 'was canceled'}`)
            .join(', '),
        },
        nodeOrServiceState.stateKey
      )
    }
    return false
  }

  const pendingNeeds = needs
    .map((need) => currentState.service[need.service.id])
    .filter((service) => service.type === 'pending')

  if (pendingNeeds.length > 0) {
    schedulePendingServices(pendingNeeds, state, processManager, environment, currentState)
    return false
  }

  const hasNotReadyNeeds = needs.some((need) => currentState.service[need.service.id].type !== 'running')
  if (hasNotReadyNeeds) {
    return false
  }

  return true
}
