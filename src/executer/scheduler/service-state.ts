import { WorkService } from '../../planner/work-service'
import { ServiceDns } from '../service-dns'

export interface ServicePendingState {
  type: 'pending'
  service: WorkService
  stateKey: string | null
}

export interface ServiceStartingState {
  type: 'starting'
  service: WorkService
  stateKey: string | null
}

export interface ServiceReadyState {
  type: 'ready'
  service: WorkService
  stateKey: string
}

export interface ServiceRunningState {
  type: 'running'
  service: WorkService
  dns: ServiceDns
  stateKey: string
}

export interface ServiceEndState {
  type: 'end'
  service: WorkService
  reason: 'crash' | 'terminated'
  stateKey: string
}

export interface ServiceCanceledState {
  type: 'canceled'
  service: WorkService
  stateKey: string | null
}

export type ServiceState =
  | ServicePendingState
  | ServiceStartingState
  | ServiceRunningState
  | ServiceReadyState
  | ServiceEndState
  | ServiceCanceledState
