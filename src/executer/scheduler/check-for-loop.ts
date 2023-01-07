import { SchedulerState } from './scheduler-state'
import { iterateWorkNodes, iterateWorkServices } from '../../planner/utils/plan-work-nodes'
import { hasDependencyCycle, hasNeedCycle } from '../../planner/validate'

export function checkForLoop(state: SchedulerState): void {
  for (const nodeState of iterateWorkNodes(state.node)) {
    const cyclePath = hasDependencyCycle(nodeState.node, [])
    if (cyclePath && cyclePath.length > 0) {
      const errorMessage = `task cycle detected ${cyclePath.map((n) => n.name).join(' -> ')}`
      state.node[nodeState.node.id] = {
        type: 'error',
        node: nodeState.node,
        stateKey: null,
        errorMessage,
      }
    }
  }
  for (const serviceState of iterateWorkServices(state.service)) {
    const cyclePath = hasNeedCycle(serviceState.service, [])
    if (cyclePath && cyclePath.length > 0) {
      const errorMessage = `service cycle detected ${cyclePath.map((n) => n.name).join(' -> ')}`
      state.service[serviceState.service.id] = {
        type: 'error',
        service: serviceState.service,
        stateKey: null,
        errorMessage,
      }
    }
  }
}
