import { SchedulerState } from './scheduler/scheduler-state'
import { SchedulerResult } from './scheduler/scheduler-result'

export function getSchedulerExecuteResult(state: SchedulerState): SchedulerResult {
  const success = !Object.values(state.node).some((n) => n.type !== 'completed')
  return {
    state,
    success,
  }
}
