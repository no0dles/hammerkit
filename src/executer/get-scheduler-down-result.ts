import { SchedulerResult } from './scheduler/scheduler-result'
import { WorkTree } from '../planner/work-tree'

export function getSchedulerDownResult(state: WorkTree): SchedulerResult {
  const success = !Object.values(state.services).some(
    (n) => n.state.current.type === 'running' || n.state.current.type === 'starting'
  )
  return {
    state,
    success,
  }
}
