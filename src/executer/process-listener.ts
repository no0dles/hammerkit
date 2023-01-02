import { ProcessItem } from './process-item'
import { LogContext } from '../planner/work-node-status'

export type ProcessListenerEventType = 'ended' | 'started' | 'cancel'

export interface ProcessListenerEvent {
  type: ProcessListenerEventType
  context: LogContext
}

export interface PendingItem {
  context: LogContext
}

export type ProcessListener = (evt: ProcessListenerEvent, processes: ProcessItem[], pending: PendingItem[]) => void
