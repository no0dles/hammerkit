import { SchedulerState } from './scheduler/scheduler-state'
import { SchedulerResult } from './scheduler/scheduler-result'

export function getSchedulerUpResult(state: SchedulerState): SchedulerResult {
  const success = !Object.values(state.service).some((n) => n.type !== 'running')
  return {
    state,
    success,
  }
}
