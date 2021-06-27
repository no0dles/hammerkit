import { WorkTree } from '../planner/work-tree'
import { WorkNode } from '../planner/work-node'

export function getReadyWorkNodes(workTree: WorkTree): WorkNode[] {
  const result: WorkNode[] = []

  for (const key of Object.keys(workTree.nodes)) {
    const node = workTree.nodes[key]
    if (node.status.state.type === 'pending' && Object.keys(node.status.pendingDependencies).length === 0) {
      result.push(node)
    }
  }

  return result
}
