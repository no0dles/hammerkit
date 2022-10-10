import { WorkNode } from '../planner/work-node'
import { WorkService } from '../planner/work-service'
import { SchedulerState } from './scheduler/scheduler-state'

export interface NodeStartEvent {
  type: 'node-start'
  node: WorkNode
  abortController: AbortController
}

export interface NodeCrashEvent {
  type: 'node-crash'
  node: WorkNode
  command: string
  exitCode: number
}

export interface NodeWatchStartEvent {
  type: 'node-watch-start'
  node: WorkNode
  sources: string[]
}

export interface NodeWatchCanceledEvent {
  type: 'node-watch-canceled'
  node: WorkNode
}

export interface ServiceWatchStartEvent {
  type: 'service-watch-start'
  service: WorkService
  mounts: string[]
}

export interface ServiceWatchCanceledEvent {
  type: 'service-watch-canceled'
  service: WorkService
}

export interface ServiceWatchResetEvent {
  type: 'service-watch-reset'
  service: WorkService
}

export interface NodeWatchResetEvent {
  type: 'node-watch-reset'
  node: WorkNode
}

export interface NodeCanceledEvent {
  type: 'node-canceled'
  node: WorkNode
}

export interface NodeErrorEvent {
  type: 'node-error'
  node: WorkNode
  errorMessage: string
}

export interface NodeCachedEvent {
  type: 'node-cached'
  node: WorkNode
}

export interface NodeCompletedEvent {
  type: 'node-completed'
  node: WorkNode
}

export interface ServiceStartEvent {
  type: 'service-start'
  service: WorkService
  abortController: AbortController
}

export interface ServiceReadyEvent {
  type: 'service-ready'
  service: WorkService
  dns: ServiceDns
}

export interface ServiceHostDns {
  host: string
}
export interface ServiceContainerDns {
  containerId: string
}
export type ServiceDns = ServiceHostDns | ServiceContainerDns

export const isHostServiceDns = (val: ServiceDns): val is ServiceHostDns => 'host' in val

export interface ServiceCrashEvent {
  type: 'service-crash'
  service: WorkService
  errorMessage: string
}

export interface ServiceCanceledEvent {
  type: 'service-canceled'
  service: WorkService
}

export interface SchedulerUpdateEvent {
  type: 'scheduler-update'
  state: SchedulerState
}

export type SchedulerEvent = SchedulerUpdateEvent
export type ServiceEvent =
  | ServiceWatchCanceledEvent
  | ServiceWatchResetEvent
  | ServiceWatchStartEvent
  | ServiceCrashEvent
  | ServiceStartEvent
  | ServiceCanceledEvent
  | ServiceReadyEvent
export type NodeEvent =
  | NodeStartEvent
  | NodeCrashEvent
  | NodeCanceledEvent
  | NodeCachedEvent
  | NodeCompletedEvent
  | NodeErrorEvent
  | NodeWatchStartEvent
  | NodeWatchResetEvent
  | NodeWatchCanceledEvent

export type HammerkitEvent = SchedulerEvent | ServiceEvent | NodeEvent
