import { WorkService } from '../../planner/work-service'

export interface ServicePendingState {
  type: 'pending'
  service: WorkService
}

export interface ServiceRunningState {
  type: 'running'
  abortController: AbortController
  service: WorkService
}

export interface ServiceReadyState {
  type: 'ready'
  abortController: AbortController
  service: WorkService
  containerId: string
}

export interface ServiceEndState {
  type: 'end'
  service: WorkService
  reason: 'cancelled' | 'crash'
}

export type ServiceState = ServicePendingState | ServiceRunningState | ServiceReadyState | ServiceEndState
