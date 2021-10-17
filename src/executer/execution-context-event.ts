import { WorkTree } from '../planner/work-tree'
import { WorkNodeState } from '../planner/work-node-status'
import { WorkServiceState } from '../planner/work-service-state'

export type ExecutionContextEvent = ExecutionContextServiceEvent | ExecutionContextNodeEvent

export interface ExecutionContextServiceEvent {
  type: 'service'

  workTree: WorkTree

  oldState: WorkServiceState
  newState: WorkServiceState

  serviceId: string
}

export interface ExecutionContextNodeEvent {
  type: 'node'

  workTree: WorkTree

  oldState: WorkNodeState
  newState: WorkNodeState

  nodeId: string
}
