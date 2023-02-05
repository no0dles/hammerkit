import { WorkNode } from './work-node'
import { WorkItem } from './work-item'

export interface WorkNodes {
  [key: string]: WorkItem<WorkNode>
}
