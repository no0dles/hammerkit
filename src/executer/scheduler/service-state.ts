import { WorkService } from '../../planner/work-service'
import { ServiceDns } from '../service-dns'
import { NodeState } from './node-state'

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
  remote: { pid?: number; containerId: string } | null
}

export interface ServiceEndState {
  type: 'end'
  service: WorkService
  reason: 'crash' | 'terminated'
  stateKey: string
}

export interface ServiceErrorState {
  type: 'error'
  service: WorkService
  stateKey: string | null
  errorMessage: string
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
  | ServiceErrorState
  | ServiceEndState
  | ServiceCanceledState

export const isServiceState = (val: ServiceState | NodeState): val is ServiceState => 'service' in val
