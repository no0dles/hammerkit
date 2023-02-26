import { ProcessItem } from './process-item'
import { WorkItem } from '../planner/work-item'
import { WorkTask } from '../planner/work-task'
import { WorkService } from '../planner/work-service'

export type ProcessListenerEventType = 'ended' | 'started' | 'cancel'

export interface ProcessListenerEvent {
  type: ProcessListenerEventType
  item: WorkItem<WorkTask | WorkService>
}

export interface PendingItem {
  item: WorkItem<WorkTask | WorkService>
}

export type ProcessListener = (evt: ProcessListenerEvent, processes: ProcessItem[], pending: PendingItem[]) => void
