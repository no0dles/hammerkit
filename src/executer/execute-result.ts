import { WorkNodeState } from '../planner/work-node-status'

export interface ExecuteResult {
  success: boolean
  nodes: { [key: string]: WorkNodeState }
}
