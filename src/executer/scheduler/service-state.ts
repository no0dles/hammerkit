import { WorkService } from '../../planner/work-service'
import { ServiceDns } from '../events'

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
  dns: ServiceDns
}

export interface ServiceEndState {
  type: 'end'
  service: WorkService
  reason: 'canceled' | 'crash'
}

export type ServiceState = ServicePendingState | ServiceRunningState | ServiceReadyState | ServiceEndState
