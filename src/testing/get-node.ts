import { BuildFile } from '../parser/build-file'
import { WorkTree } from '../planner/work-tree'
import { WorkNode } from '../planner/work-node'

export function getNode(buildFile: BuildFile, workTree: WorkTree, taskName: string): WorkNode {
  return workTree.nodes[`${buildFile.path}:${taskName}`]
}
