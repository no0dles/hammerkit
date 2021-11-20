import { BuildFile } from '../parser/build-file'
import { WorkNode } from '../planner/work-node'
import { WorkNodes } from '../planner/work-nodes'

export function getNode(buildFile: BuildFile, nodes: WorkNodes, taskName: string): WorkNode {
  const node = Object.values(nodes).find((n) => n.name === taskName)
  if (!node) {
    throw new Error(`could not find node ${taskName}`)
  }
  return node
}
