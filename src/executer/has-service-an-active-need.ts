import { SchedulerState } from './scheduler/scheduler-state'
import { iterateWorkNodes, iterateWorkServices } from '../planner/utils/plan-work-nodes'

export function hasServiceAnActiveNeed(currentState: SchedulerState, serviceId: string) {
  let hasNeed = false
  for (const nodeState of iterateWorkNodes(currentState.node)) {
    if (nodeState.type === 'running' || nodeState.type === 'starting' || nodeState.type === 'pending') {
      if (nodeState.node.needs.some((n) => n.service.id === serviceId)) {
        hasNeed = true
        break
      }
    }
  }

  if (!hasNeed) {
    for (const serviceState of iterateWorkServices(currentState.service)) {
      if (
        serviceState.type === 'ready' ||
        serviceState.type === 'running' ||
        serviceState.type === 'starting' ||
        serviceState.type === 'pending'
      ) {
        if (serviceState.service.needs.some((n) => n.service.id === serviceId)) {
          hasNeed = true
          break
        }
      }
    }
  }
  return hasNeed
}
