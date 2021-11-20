import { WorkNode } from '../../planner/work-node'

export interface NodePendingState {
  type: 'pending'
  node: WorkNode
}

export interface NodeRunningState {
  type: 'running'
  abortController: AbortController
  node: WorkNode
  result: Promise<void>
  started: Date
}

export interface NodeCompletedState {
  type: 'completed'
  node: WorkNode
  duration: number
}

export interface NodeCrashState {
  type: 'crash'
  node: WorkNode
  errorMessage: string
}

export interface NodeCanceledState {
  type: 'canceled'
  node: WorkNode
}

export interface NodeAbortState {
  type: 'abort'
  node: WorkNode
  exitCode: number
}

export type NodeState =
  | NodePendingState
  | NodeRunningState
  | NodeCompletedState
  | NodeCrashState
  | NodeAbortState
  | NodeCanceledState
