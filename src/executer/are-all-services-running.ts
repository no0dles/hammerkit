import { SchedulerState } from './scheduler/scheduler-state'
import { iterateWorkServices } from '../planner/utils/plan-work-nodes'

export function areAllServicesRunning(state: SchedulerState): boolean {
  for (const service of iterateWorkServices(state.service)) {
    if (service.type !== 'running') {
      return false
    }
  }
  return true
}
