import { WorkTree } from '../planner/work-tree'
import { WorkNodeState } from '../planner/work-node-status'

export interface ExecutionContextEvent {
  workTree: WorkTree
  oldState: WorkNodeState
  newState: WorkNodeState
  nodeId: string
}
