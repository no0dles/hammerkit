import { ServiceDns } from '../service-dns'

export interface ServicePendingState {
  type: 'pending'
  stateKey: string | null
}

export interface ServiceStartingState {
  type: 'starting'
  stateKey: string | null
}

export interface ServiceReadyState {
  type: 'ready'
  stateKey: string
}

export interface ServiceRunningState {
  type: 'running'
  dns: ServiceDns
  stateKey: string
  remote: { pid?: number; containerId: string } | null
}

export interface ServiceEndState {
  type: 'end'
  reason: 'crash' | 'terminated'
  stateKey: string | null
}

export interface ServiceErrorState {
  type: 'error'
  stateKey: string | null
  errorMessage: string
}

export interface ServiceCanceledState {
  type: 'canceled'
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
