import { SchedulerState } from './scheduler/scheduler-state'
import { iterateWorkServices } from '../planner/utils/plan-work-nodes'

export function areAllServicesDown(state: SchedulerState): boolean {
  for (const service of iterateWorkServices(state.service)) {
    if (service.type === 'running' || service.type === 'starting' || service.type === 'canceled') {
      return false
    }
  }
  return true
}
