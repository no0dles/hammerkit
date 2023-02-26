export interface NodePendingState {
  type: 'pending'
  stateKey: string | null
}

export interface NodeStartingState {
  type: 'starting'
  started: Date
  stateKey: string | null
}

export interface NodeReadyState {
  type: 'ready'
  started: Date
  stateKey: string
}

export interface NodeRunningState {
  type: 'running'
  started: Date
  stateKey: string
}

export interface NodeCompletedState {
  type: 'completed'
  duration: number
  cached: boolean
  stateKey: string
}

export interface NodeErrorState {
  type: 'error'
  errorMessage: string
  stateKey: string | null
}

export interface NodeCanceledState {
  type: 'canceled'
  stateKey: string | null
}

export interface NodeCrashState {
  type: 'crash'
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
