import { ServiceDns } from '../service-dns'
import { NodeState } from './node-state'
import { WorkService } from '../../planner/work-service'
import { WorkItem } from '../../planner/work-item'
import { WorkNode } from '../../planner/work-node'
import { WorkServices } from '../../planner/work-services'

export interface ServicePendingState {
  type: 'pending'
  service: WorkItem<WorkService>
  stateKey: string | null
  itemId: string
}

export interface ServiceStartingState {
  type: 'starting'
  service: WorkItem<WorkService>
  stateKey: string | null
  itemId: string
}

export interface ServiceReadyState {
  type: 'ready'
  service: WorkItem<WorkService>
  stateKey: string
  itemId: string
}

export interface ServiceRunningState {
  type: 'running'
  service: WorkItem<WorkService>
  dns: ServiceDns
  stateKey: string
  remote: { pid?: number; containerId: string } | null
  itemId: string
}

export interface ServiceEndState {
  type: 'end'
  service: WorkItem<WorkService>
  reason: 'crash' | 'terminated'
  stateKey: string
  itemId: string
}

export interface ServiceErrorState {
  type: 'error'
  service: WorkItem<WorkService>
  stateKey: string | null
  errorMessage: string
  itemId: string
}

export interface ServiceCanceledState {
  type: 'canceled'
  service: WorkItem<WorkService>
  stateKey: string | null
  itemId: string
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
