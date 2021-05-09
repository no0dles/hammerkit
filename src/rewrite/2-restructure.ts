import { TaskNode, TaskTree, TreeNodes } from './1-plan'

export interface TreeDependencies {
  [key: string]: TreeDependencyNode
}

export interface TreeDependencyNode {
  task: TaskNode
  dependencies: string[]
}

export function restructure(tree: TaskTree): TreeDependencies {
  const treeDependencies: TreeDependencies = {}
  addDependencies(tree.rootNode, tree.nodes, treeDependencies, [tree.rootNode.id])
  return treeDependencies
}

function addDependencies(node: TaskNode, tree: TreeNodes, treeDependencies: TreeDependencies, path: string[]) {
  const dependencies: string[] = []
  for (const dep of node.deps) {
    dependencies.push(dep.id)

    if (path.indexOf(dep.id) >= 0) {
      throw new Error(`dependency cycle ${path.join(' -> ')} -> ${dep.id}`)
    }

    if (!treeDependencies[dep.id]) {
      addDependencies(dep, tree, treeDependencies, [...path, dep.id])
    }

    for (const subDep of treeDependencies[dep.id].dependencies) {
      if (dependencies.indexOf(subDep) === -1) {
        dependencies.push(subDep)
      }
    }
  }

  treeDependencies[node.id] = { task: node, dependencies }
}