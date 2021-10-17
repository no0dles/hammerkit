import { WorkNodes } from './work-nodes'
import { WorkNode } from './work-node'
import { WorkServices } from './work-services'

export interface WorkTree {
  nodes: WorkNodes
  rootNode: WorkNode
  services: WorkServices
}
