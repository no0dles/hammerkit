import { LogContext } from '../planner/work-node-status'

export interface ProcessItem {
  context: LogContext
  started: Date
  promise: Promise<any>
}
