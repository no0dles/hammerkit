import {WorkNode} from './work-node';
import {Defer} from '../defer';
import {Readable, Writable} from 'stream';

export interface WorkNodeStatus {
  pendingDependencies: { [id: string]: WorkNode }
  completedDependencies: { [id: string]: WorkNode }
  state: WorkNodeState
  defer: Defer<void>
  stderr: Writable

  stderrRead(): Readable

  stdout: Writable,

  stdoutRead(): Readable
}

export type WorkNodeState =
  | WorkNodePendingState
  | WorkNodeRunningState
  | WorkNodeCompletedState
  | WorkNodeFailedState
  | WorkNodeAbortedState
  | WorkNodeCancelState

export interface WorkNodePendingState {
  type: 'pending'
}

export interface WorkNodeCancelState {
  type: 'cancel'
}

export interface WorkNodeAbortedState {
  type: 'aborted'
}

export interface WorkNodeRunningState {
  type: 'running'
  started: Date
  cancelDefer: Defer<void>
}

export const isRunningState = (val: WorkNodeState): val is WorkNodeRunningState => val.type === 'running';

export interface WorkNodeCompletedState {
  type: 'completed'
  duration: number
  ended: Date
}

export const isCompletedState = (val: WorkNodeState): val is WorkNodeCompletedState => val.type === 'completed';

export interface WorkNodeFailedState {
  type: 'failed'
  duration: number
  error: Error
  ended: Date
}
