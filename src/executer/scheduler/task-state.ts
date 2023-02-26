export interface TaskPendingState {
  type: 'pending'
  stateKey: string | null
}

export interface TaskStartingState {
  type: 'starting'
  started: Date
  stateKey: string | null
}

export interface TaskReadyState {
  type: 'ready'
  started: Date
  stateKey: string
}

export interface TaskRunningState {
  type: 'running'
  started: Date
  stateKey: string
}

export interface TaskCompletedState {
  type: 'completed'
  duration: number
  cached: boolean
  stateKey: string
}

export interface TaskErrorState {
  type: 'error'
  errorMessage: string
  stateKey: string | null
}

export interface TaskCanceledState {
  type: 'canceled'
  stateKey: string | null
}

export interface TaskCrashState {
  type: 'crash'
  exitCode: number
  stateKey: string
}

export type TaskState =
  | TaskPendingState
  | TaskStartingState
  | TaskReadyState
  | TaskRunningState
  | TaskCompletedState
  | TaskErrorState
  | TaskCrashState
  | TaskCanceledState
