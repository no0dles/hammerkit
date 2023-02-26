import { SchedulerResult } from './scheduler/scheduler-result'
import { WorkTree } from '../planner/work-tree'
import { iterateWorkNodes, iterateWorkServices } from '../planner/utils/plan-work-nodes'

export function getSchedulerExecuteResult(state: WorkTree): SchedulerResult {
  for (const node of iterateWorkNodes(state)) {
    if (node.state.current.type !== 'completed') {
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
