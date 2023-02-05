import { LogContext } from '../planner/work-node-status'

export interface ProcessItem {
  id: string
  started: Date
  promise: Promise<any>
  abortController: AbortController
}
