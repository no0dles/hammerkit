import { ProcessItem } from './process-item'

export type ProcessListenerEventType = 'ended' | 'started'

export interface ProcessListenerEvent {
  type: ProcessListenerEventType
  process: ProcessItem
}

export type ProcessListener = (evt: ProcessListenerEvent, processes: ProcessItem[]) => void
