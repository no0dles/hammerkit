import { WorkTree } from '../planner/work-tree'
import { WorkNode } from '../planner/work-node'
import { iterateWorkNodes } from '../planner/utils/plan-work-nodes'

export function getReadyWorkNodes(workTree: WorkTree): WorkNode[] {
  const result: WorkNode[] = []

  for (const node of iterateWorkNodes(workTree.nodes)) {
    if (node.status.state.type === 'pending' && Object.keys(node.status.pendingDependencies).length === 0) {
      result.push(node)
    }
  }

  return result
}
