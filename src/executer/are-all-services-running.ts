import { iterateWorkServices } from '../planner/utils/plan-work-nodes'
import { WorkTree } from '../planner/work-tree'

export function areAllServicesRunning(workTree: WorkTree): boolean {
  for (const service of iterateWorkServices(workTree)) {
    if (service.state.current.type !== 'running') {
      return false
    }
  }
  return true
}
