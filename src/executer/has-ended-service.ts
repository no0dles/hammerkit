import { iterateWorkServices } from '../planner/utils/plan-work-nodes'
import { WorkTree } from '../planner/work-tree'

export function hasEndedService(state: WorkTree): boolean {
  for (const service of iterateWorkServices(state)) {
    if (service.state.current.type === 'end' || service.state.current.type === 'error') {
      return true
    }
  }

  return false
}
