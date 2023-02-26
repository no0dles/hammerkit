import { iterateWorkNodes, iterateWorkServices } from '../planner/utils/plan-work-nodes'
import { WorkItemState } from '../planner/work-item'
import { WorkService } from '../planner/work-service'
import { ServiceState } from './scheduler/service-state'
import { WorkTree } from '../planner/work-tree'

export function hasServiceAnActiveNeed(currentState: WorkTree, service: WorkItemState<WorkService, ServiceState>) {
  let hasNeed = false
  for (const node of iterateWorkNodes(currentState)) {
    if (
      node.state.current.type === 'running' ||
      node.state.current.type === 'starting' ||
      node.state.current.type === 'pending'
    ) {
      if (node.needs.some((n) => n.service.id === service.id)) {
        hasNeed = true
        break
      }
    }
  }

  if (!hasNeed) {
    for (const serviceState of iterateWorkServices(currentState)) {
      if (
        serviceState.state.current.type === 'ready' ||
        serviceState.state.current.type === 'running' ||
        serviceState.state.current.type === 'starting' ||
        serviceState.state.current.type === 'pending'
      ) {
        if (serviceState.needs.some((n) => n.service.id === service.id)) {
          hasNeed = true
          break
        }
      }
    }
  }
  return hasNeed
}
