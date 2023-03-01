import { iterateWorkServices } from '../planner/utils/plan-work-tasks'
import { WorkTree } from '../planner/work-tree'

export async function updateServiceStatus(workTree: WorkTree): Promise<void> {
  for (const service of iterateWorkServices(workTree)) {
    await service.runtime.initialize(service.state)
  }
}
