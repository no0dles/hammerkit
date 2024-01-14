import { SchedulerResult } from './scheduler/scheduler-result'
import { WorkTree } from '../planner/work-tree'
import { iterateWorkTasks, iterateWorkServices } from '../planner/utils/plan-work-tasks'

export function getSchedulerExecuteResult(state: WorkTree): SchedulerResult {
  for (const task of iterateWorkTasks(state)) {
    if (task.state.current.type !== 'completed') {
      return {
        state,
        success: false,
      }
    }
  }
  for (const service of iterateWorkServices(state)) {
    if (service.state.current.type === 'canceled') {
      return {
        state,
        success: false,
      }
    }
  }
  return {
    success: true,
    state,
  }
}
