import { WorkNode } from '../../planner/work-node'

export interface NodePendingState {
  type: 'pending'
  node: WorkNode
}

export interface NodeStartingState {
  type: 'starting'
  abortController: AbortController
  node: WorkNode
  started: Date
}

export interface NodeRunningState {
  type: 'running'
  abortController: AbortController
  stateKey: string
  node: WorkNode
  started: Date
}

export interface NodeCompletedState {
  type: 'completed'
  node: WorkNode
  duration: number
  cached: boolean
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
  | NodeStartingState
  | NodeRunningState
  | NodeCompletedState
  | NodeErrorState
  | NodeCrashState
  | NodeCanceledState
