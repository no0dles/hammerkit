import { WorkNode } from '../../planner/work-node'
import { WorkItem } from '../../planner/work-item'
import { WorkService } from '../../planner/work-service'

export interface NodePendingState {
  type: 'pending'
  node: WorkItem<WorkNode>
  itemId: string
  stateKey: string | null
}

export interface NodeStartingState {
  type: 'starting'
  node: WorkItem<WorkNode>
  started: Date
  itemId: string
  stateKey: string | null
}

export interface NodeReadyState {
  type: 'ready'
  node: WorkItem<WorkNode>
  started: Date
  stateKey: string
  itemId: string
}

export interface NodeRunningState {
  type: 'running'
  node: WorkItem<WorkNode>
  started: Date
  stateKey: string
  itemId: string
}

export interface NodeCompletedState {
  type: 'completed'
  node: WorkItem<WorkNode>
  duration: number
  cached: boolean
  stateKey: string
  itemId: string
}

export interface NodeErrorState {
  type: 'error'
  node: WorkItem<WorkNode>
  errorMessage: string
  stateKey: string | null
  itemId: string
}

export interface NodeCanceledState {
  type: 'canceled'
  node: WorkItem<WorkNode>
  stateKey: string | null
  itemId: string
}

export interface NodeCrashState {
  type: 'crash'
  node: WorkItem<WorkNode>
  exitCode: number
  stateKey: string
  itemId: string
}

export type NodeState =
  | NodePendingState
  | NodeStartingState
  | NodeReadyState
  | NodeRunningState
  | NodeCompletedState
  | NodeErrorState
  | NodeCrashState
  | NodeCanceledState
