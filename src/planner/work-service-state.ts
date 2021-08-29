import { WorkNodeConsole } from './work-node-status'

export interface WorkServiceStatus {
  state: WorkServiceState
  defer: AbortController
  console: WorkNodeConsole
}

export type WorkServiceState = WorkServicePendingState | WorkServiceRunningState | WorkServiceReadyState

export interface WorkServicePendingState {
  type: 'pending'
}

export interface WorkServiceRunningState {
  type: 'running'
  containerName: string
}

export interface WorkServiceReadyState {
  type: 'ready'
  containerName: string
}
