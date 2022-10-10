import { BuildFile } from '../parser/build-file'
import { planWorkNodes } from './utils/plan-work-nodes'
import { planWorkTree } from './utils/plan-work-tree'
import { WorkNode } from './work-node'
import { WorkNodeValidation } from './work-node-validation'
import { Environment } from '../executer/environment'
import { WorkTree } from './work-tree'

function plan(buileFile: BuildFile, name?: string): WorkTree {
  if (name) {
    return planWorkTree(buileFile, { taskName: name, noContainer: false })
  } else {
    return planWorkNodes(buileFile, { filterLabels: {}, excludeLabels: {}, noContainer: false })
  }
}

export async function* validate(
  buildFile: BuildFile,
  context: Environment,
  name?: string
): AsyncGenerator<WorkNodeValidation> {
  const workTree = plan(buildFile, name) // TODO validate services
  const cycleNodes: WorkNode[] = []

  for (const [key, node] of Object.entries(workTree.nodes)) {
    if (!node.description) {
      yield { type: 'warn', message: `missing description`, node: node }
    }

    if ((!node.cmds || node.cmds.length === 0) && (!node.deps || node.deps.length === 0)) {
      yield { type: 'warn', message: `task is empty`, node: node }
    }

    for (const src of node.src) {
      if (!(await context.file.exists(src.absolutePath))) {
        yield {
          type: 'warn',
          message: `src ${src.absolutePath} does not exist`,
          node: node,
        }
      }
    }

    for (const key of Object.keys(node.plannedTask.buildTask.unknownProps)) {
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

export function hasCycle(node: WorkNode, currentPath: WorkNode[]): WorkNode[] | null {
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
