import { iterateWorkNodes, iterateWorkServices } from '../../planner/utils/plan-work-nodes'
import { hasDependencyCycle, hasNeedCycle } from '../../planner/validate'
import { WorkTree } from '../../planner/work-tree'

export function checkForLoop(workTree: WorkTree): void {
  for (const node of iterateWorkNodes(workTree)) {
    const cyclePath = hasDependencyCycle(node, [])
    if (cyclePath && cyclePath.length > 0) {
      const errorMessage = `task cycle detected ${cyclePath.map((n) => n.name).join(' -> ')}`
      node.state.set({
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
