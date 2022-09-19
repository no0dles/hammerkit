import { ContainerWorkNode, LocalWorkNode, WorkNode } from '../planner/work-node'
import { WorkService } from '../planner/work-service'
import { WorkNodes } from '../planner/work-nodes'
import { WorkServices } from '../planner/work-services'
import { SchedulerState } from './scheduler/scheduler-state'
import { CacheMethod } from '../optimizer/cache-method'

export interface NodeCleanupEvent {
  type: 'node-cleanup'
  node: WorkNode
}

export interface NodePruneStateEvent {
  type: 'node-prune-state'
  node: WorkNode
}

export interface NodeStoreStateEvent {
  type: 'node-store-state'
  node: WorkNode
  path: string
}

export interface NodeRestoreStateEvent {
  type: 'node-restore-state'
  node: WorkNode
  path: string
}

export interface NodeStartEvent {
  type: 'node-start'
  node: WorkNode
}

export interface NodeCrashEvent {
  type: 'node-crash'
  node: WorkNode
  command: string
  exitCode: number
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

export interface NodeCompletedEvent {
  type: 'node-completed'
  node: WorkNode
}

export interface ServiceCleanupEvent {
  type: 'service-cleanup'
  service: WorkService
}

export interface ServicePruneEvent {
  type: 'service-prune'
  service: WorkService
}

export interface ServiceStartEvent {
  type: 'service-start'
  service: WorkService
}

export interface ServiceReadyEvent {
  type: 'service-ready'
  service: WorkService
  containerId: string
}

export interface ServiceCrashEvent {
  type: 'service-crash'
  service: WorkService
  errorMessage: string
}

export interface ServiceCancelledEvent {
  type: 'service-cancelled'
  service: WorkService
}

export interface SchedulerInitializeEvent {
  type: 'scheduler-initialize'
  nodes: WorkNodes
  services: WorkServices
  watch: boolean
  workers: number
  noContainer: boolean
  cacheMethod: CacheMethod
}

export interface SchedulerUpdateEvent {
  type: 'scheduler-update'
  state: SchedulerState
}

export interface SchedulerStartContainerNodeEvent {
  type: 'scheduler-start-container-node'
  node: ContainerWorkNode
  abortSignal: AbortSignal
  serviceContainers: { [key: string]: string }
}

export interface SchedulerStartLocalNodeEvent {
  type: 'scheduler-start-local-node'
  node: LocalWorkNode | ContainerWorkNode
  abortSignal: AbortSignal
}

export interface SchedulerStartServiceEvent {
  type: 'scheduler-start-service'
  service: WorkService
  abortSignal: AbortSignal
}

export interface SchedulerUpEvent {
  type: 'scheduler-up'
  services: WorkServices
  watch: boolean
}

export interface SchedulerUpResultEvent {
  type: 'scheduler-up-result'
}

export interface SchedulerTerminationEvent {
  type: 'scheduler-termination'
  state: SchedulerState
  success: boolean
}

export interface CacheRestoreEvent {
  type: 'cache-restore'
  nodes: WorkNodes
  services: WorkServices
  path: string
}

export interface CacheStoreEvent {
  type: 'cache-store'
  nodes: WorkNodes
  services: WorkServices
  path: string
}

export interface CacheCleanEvent {
  type: 'cache-clean'
  nodes: WorkNodes
  services: WorkServices
}

export interface ProcessLogEvent {
  type: 'process-log'
  level: 'stdout' | 'stderr'
  message: string
}

export type SchedulerEvent =
  | SchedulerUpEvent
  | SchedulerUpResultEvent
  | SchedulerInitializeEvent
  | SchedulerUpdateEvent
  | SchedulerStartContainerNodeEvent
  | SchedulerStartLocalNodeEvent
  | SchedulerStartServiceEvent
  | SchedulerTerminationEvent
export type CacheEvent = CacheStoreEvent | CacheRestoreEvent | CacheCleanEvent
export type ServiceEvent =
  | ServiceCleanupEvent
  | ServiceCrashEvent
  | ServiceStartEvent
  | ServiceCancelledEvent
  | ServicePruneEvent
  | ServiceReadyEvent
export type NodeEvent =
  | NodeCleanupEvent
  | NodeStartEvent
  | NodeCrashEvent
  | NodeCanceledEvent
  | NodePruneStateEvent
  | NodeStoreStateEvent
  | NodeRestoreStateEvent
  | NodeCompletedEvent
  | NodeErrorEvent

export type HammerkitEvent = CacheEvent | SchedulerEvent | ServiceEvent | NodeEvent
