import { WorkNodes } from './work-nodes'
import { WorkNode } from './work-node'

export interface WorkTree {
  nodes: WorkNodes
  rootNode: WorkNode
}
