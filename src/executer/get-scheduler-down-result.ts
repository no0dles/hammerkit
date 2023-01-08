import { SchedulerState } from './scheduler/scheduler-state'
import { SchedulerResult } from './scheduler/scheduler-result'

export function getSchedulerDownResult(state: SchedulerState): SchedulerResult {
  const success = Object.values(state.service).some((n) => n.type === 'running' || n.type === 'starting')
  return {
    state,
    success,
  }
}
