import {WorkNodeStatus} from '../planner/work-node-status';

export interface ExecuteResult {
  success: boolean
  nodes: { [key: string]: WorkNodeStatus }
}
