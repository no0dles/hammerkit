import { iterateWorkServices } from '../planner/utils/plan-work-nodes'
import { WorkTree } from '../planner/work-tree'

export function areAllServicesDown(state: WorkTree): boolean {
  for (const service of iterateWorkServices(state)) {
    if (
      service.state.current.type === 'running' ||
      service.state.current.type === 'starting' ||
      service.state.current.type === 'canceled'
    ) {
      return false
    }
  }
  return true
}
