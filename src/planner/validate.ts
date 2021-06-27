import { existsSync } from 'fs'
import { BuildFile } from '../parser/build-file'
import { planWorkNodes } from '../planner/utils/plan-work-nodes'
import { planWorkTree } from '../planner/utils/plan-work-tree'
import { WorkNode } from '../planner/work-node'
import { WorkNodeValidation } from './work-node-validation'

export function* validate(buildFile: BuildFile, name?: string): Generator<WorkNodeValidation> {
  const tree = name ? planWorkTree(buildFile, name).nodes : planWorkNodes(buildFile)
  const cycleNodes: WorkNode[] = []

  for (const key of Object.keys(tree)) {
    const node = tree[key]
    if (!node.description) {
      yield { type: 'warn', message: `missing description`, node: node }
    }

    if ((!node.cmds || node.cmds.length === 0) && (!node.deps || node.deps.length === 0)) {
      yield { type: 'warn', message: `task is empty`, node: node }
    }

    for (const src of node.src) {
      if (!existsSync(src.absolutePath)) {
        yield {
          type: 'warn',
          message: `src ${src.absolutePath} does not exist`,
          node: node,
        }
      }
    }

    for (const key of Object.keys(node.unknownProps)) {
      yield {
        type: 'warn',
        message: `${key} is an unknown configuration`,
        node: node,
      }
    }

    if (cycleNodes.indexOf(node) === -1) {
      const cyclePath = hasCycle(node, [])
      if (cyclePath) {
        cycleNodes.push(...cyclePath)
        yield { type: 'error', message: `task cycle detected ${cyclePath.map((n) => n.name).join(' -> ')}`, node: node }
      }
    }
  }
}

function hasCycle(node: WorkNode, currentPath: WorkNode[]): WorkNode[] | null {
  if (currentPath.indexOf(node) >= 0) {
    return [...currentPath, node]
  }

  for (const dep of node.deps) {
    const depHasCycle = hasCycle(dep, [...currentPath, node])
    if (depHasCycle) {
      return depHasCycle
    }
  }

  return null
}
