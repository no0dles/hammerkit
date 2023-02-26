import { ProcessItem } from './process-item'
import { WorkItem } from '../planner/work-item'
import { WorkNode } from '../planner/work-node'
import { WorkService } from '../planner/work-service'

export type ProcessListenerEventType = 'ended' | 'started' | 'cancel'

export interface ProcessListenerEvent {
  type: ProcessListenerEventType
  item: WorkItem<WorkNode | WorkService>
}

export interface PendingItem {
  item: WorkItem<WorkNode | WorkService>
}

export type ProcessListener = (evt: ProcessListenerEvent, processes: ProcessItem[], pending: PendingItem[]) => void
