import { WorkNodes } from './work-nodes'
import { WorkNode } from './work-node'

export interface WorkTree {
  nodes: WorkNodes
  rootNode: WorkNode
}

export const isWorkTree = (val: WorkTree | WorkNodes): val is WorkTree => !!val.nodes && !!val.rootNode
