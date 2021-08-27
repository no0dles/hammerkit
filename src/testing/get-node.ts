import { BuildFile } from '../parser/build-file'
import { WorkTree } from '../planner/work-tree'
import { WorkNode } from '../planner/work-node'

export function getNode(buildFile: BuildFile, workTree: WorkTree, taskName: string): WorkNode {
  const node = Object.values(workTree.nodes).find((n) => n.name === taskName)
  if (!node) {
    throw new Error(`could not find node ${taskName}`)
  }
  return node
}
