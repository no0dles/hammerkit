import { WorkNode } from './work-node'
import { Defer } from '../defer'

export interface WorkNodeStatus {
  pendingDependencies: { [id: string]: WorkNode }
  completedDependencies: { [id: string]: WorkNode }
  state: WorkNodeState
  defer: Defer<void>
}

export type WorkNodeState =
  | WorkNodePendingState
  | WorkNodeRunningState
  | WorkNodeCompletedState
  | WorkNodeFailedState
  | WorkNodeAbortedState

export interface WorkNodePendingState {
  type: 'pending'
}

export interface WorkNodeAbortedState {
  type: 'aborted'
}

export interface WorkNodeRunningState {
  type: 'running'
  started: Date
  cancelDefer: Defer<void>
}
export const isRunningState = (val: WorkNodeState): val is WorkNodeRunningState => val.type === 'running'

export interface WorkNodeCompletedState {
  type: 'completed'
  duration: number
  ended: Date
}
export const isCompletedState = (val: WorkNodeState): val is WorkNodeCompletedState => val.type === 'completed'

export interface WorkNodeFailedState {
  type: 'failed'
  duration: number
  error: Error
  ended: Date
}
