import { WorkNode } from '../../planner/work-node'

export interface NodePendingState {
  type: 'pending'
  node: WorkNode
}

export interface NodeRunningState {
  type: 'running'
  abortController: AbortController
  node: WorkNode
  started: Date
}

export interface NodeCompletedState {
  type: 'completed'
  node: WorkNode
  duration: number
}

export interface NodeErrorState {
  type: 'error'
  node: WorkNode
  errorMessage: string
}

export interface NodeCanceledState {
  type: 'canceled'
  node: WorkNode
}

export interface NodeCrashState {
  type: 'crash'
  node: WorkNode
  exitCode: number
}

export type NodeState =
  | NodePendingState
  | NodeRunningState
  | NodeCompletedState
  | NodeErrorState
  | NodeCrashState
  | NodeCanceledState
