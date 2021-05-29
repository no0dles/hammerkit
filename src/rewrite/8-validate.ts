import { nodes, plan, TaskNode } from './1-plan'
import { BuildFileValidation } from '../build-file-validation'
import { existsSync } from 'fs'
import { ExecutionBuildFile } from './0-parse'
import { restructure } from './2-restructure'

export function* validate(buildFile: ExecutionBuildFile, name?: string): Generator<BuildFileValidation> {
  const tree = name ? plan(buildFile, name).nodes : nodes(buildFile)
  const cycleNodes: TaskNode[] = []

  const dependencyTree = restructure(tree)
  for (const nodeId of Object.keys(dependencyTree)) {
    const watchDependencies = dependencyTree[nodeId].dependencies
      .filter((dp) => tree[dp].watch)
      .map((dp) => tree[dp].name)
    if (watchDependencies.length > 0) {
      yield {
        type: 'error',
        message: `task can not depend on watched task(s) ${watchDependencies.join(', ')}`,
        task: dependencyTree[nodeId].task,
      }
    }
  }

  for (const key of Object.keys(tree)) {
    const node = tree[key]
    if (!node.description) {
      yield { type: 'warn', message: `missing description`, task: node }
    }

    if ((!node.cmds || node.cmds.length === 0) && (!node.deps || node.deps.length === 0)) {
      yield { type: 'warn', message: `task is empty`, task: node }
    }

    for (const src of node.src) {
      if (!existsSync(src.absolutePath)) {
        yield {
          type: 'warn',
          message: `src ${src.absolutePath} does not exist`,
          task: node,
        }
      }
    }

    for (const key of Object.keys(node.unknownProps)) {
      yield {
        type: 'warn',
        message: `${key} is an unknown configuration`,
        task: node,
      }
    }

    if (cycleNodes.indexOf(node) === -1) {
      const cyclePath = hasCycle(node, [])
      if (cyclePath) {
        cycleNodes.push(...cyclePath)
        yield { type: 'error', message: `task cycle detected ${cyclePath.map((n) => n.name).join(' -> ')}`, task: node }
      }
    }
  }
}

function hasCycle(node: TaskNode, currentPath: TaskNode[]): TaskNode[] | null {
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
