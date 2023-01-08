import { SchedulerState } from './scheduler/scheduler-state'
import { iterateWorkServices } from '../planner/utils/plan-work-nodes'

export function hasEndedService(state: SchedulerState): boolean {
  for (const service of iterateWorkServices(state.service)) {
    if (service.type === 'end' || service.type === 'error') {
      return true
    }
  }

  return false
}
