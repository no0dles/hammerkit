import { iterateWorkTasks, iterateWorkServices } from '../../planner/utils/plan-work-tasks'
import { hasDependencyCycle, hasNeedCycle } from '../../planner/validate'
import { WorkTree } from '../../planner/work-tree'

export function checkForLoop(workTree: WorkTree): void {
  for (const task of iterateWorkTasks(workTree)) {
    const cyclePath = hasDependencyCycle(task, [])
    if (cyclePath && cyclePath.length > 0) {
      const errorMessage = `task cycle detected ${cyclePath.map((n) => n.name).join(' -> ')}`
      task.state.set({
        type: 'error',
        stateKey: null,
        errorMessage,
      })
    }
  }
  for (const service of iterateWorkServices(workTree)) {
    const cyclePath = hasNeedCycle(service, [])
    if (cyclePath && cyclePath.length > 0) {
      const errorMessage = `service cycle detected ${cyclePath.map((n) => n.name).join(' -> ')}`
      service.state.set({
        type: 'error',
        stateKey: null,
        errorMessage,
      })
    }
  }
}
