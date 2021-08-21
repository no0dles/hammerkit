import { WorkNode } from '../work-node'
import { WorkNodes } from '../work-nodes'
import { WorkContext } from '../work-context'

export function planWorkDependency(
  deps: WorkNode[],
  node: WorkNode,
  taskName: string,
  nodes: WorkNodes,
  context: WorkContext
): void {
  for (const depNode of deps) {
    if (node.deps.some((d) => d.id === depNode.id)) {
      continue
    }

    node.deps.push(depNode)

    if (node.status.state.type === 'pending') {
      node.status.state.pendingDependencies[depNode.id] = depNode
    }

    for (const src of depNode.src) {
      if (node.src.indexOf(src) === -1) {
        node.src.push(src)
      }
    }

    for (const generate of depNode.generates) {
      if (!node.generates.some((g) => g.path === generate.path)) {
        node.generates.push({ path: generate.path, inherited: true })
      }
    }

    planWorkDependency(depNode.deps, node, taskName, nodes, context)
  }
}
