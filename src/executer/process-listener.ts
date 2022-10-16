import { ProcessItem } from './process-item'
import { LogContext } from '../planner/work-node-status'

export type ProcessListenerEventType = 'ended' | 'started'

export interface ProcessListenerEvent {
  type: ProcessListenerEventType
  process: ProcessItem
}

export interface PendingItem {
  context: LogContext
}

export type ProcessListener = (evt: ProcessListenerEvent, processes: ProcessItem[], pending: PendingItem[]) => void
