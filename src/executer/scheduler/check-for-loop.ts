import { SchedulerState } from './scheduler-state'
import { iterateWorkNodes } from '../../planner/utils/plan-work-nodes'
import { hasCycle } from '../../planner/validate'

export function checkForLoop(state: SchedulerState): void {
  for (const nodeState of iterateWorkNodes(state.node)) {
    const cyclePath = hasCycle(nodeState.node, [])
    if (cyclePath && cyclePath.length > 0) {
      const errorMessage = `task cycle detected ${cyclePath.map((n) => n.name).join(' -> ')}`
      state.node[nodeState.node.id] = {
        type: 'error',
        node: nodeState.node,
        stateKey: null,
        errorMessage,
      }
    }
  }
}
