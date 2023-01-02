import { WorkNode } from '../../planner/work-node'

export interface NodePendingState {
  type: 'pending'
  node: WorkNode
  stateKey: string | null
}

export interface NodeStartingState {
  type: 'starting'
  node: WorkNode
  started: Date
  stateKey: string | null
}

export interface NodeReadyState {
  type: 'ready'
  node: WorkNode
  started: Date
  stateKey: string
}

export interface NodeRunningState {
  type: 'running'
  node: WorkNode
  started: Date
  stateKey: string
}

export interface NodeCompletedState {
  type: 'completed'
  node: WorkNode
  duration: number
  cached: boolean
  stateKey: string
}

export interface NodeErrorState {
  type: 'error'
  node: WorkNode
  errorMessage: string
  stateKey: string | null
}

export interface NodeCanceledState {
  type: 'canceled'
  node: WorkNode
  stateKey: string | null
}

export interface NodeCrashState {
  type: 'crash'
  node: WorkNode
  exitCode: number
  stateKey: string
}

export type NodeState =
  | NodePendingState
  | NodeStartingState
  | NodeReadyState
  | NodeRunningState
  | NodeCompletedState
  | NodeErrorState
  | NodeCrashState
  | NodeCanceledState
