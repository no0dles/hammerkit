import { WorkEnvironment } from './work-environment'
import { WorkItemState } from './work-item'
import { WorkNode } from './work-node'
import { NodeState } from '../executer/scheduler/node-state'
import { WorkService } from './work-service'
import { ServiceState } from '../executer/scheduler/service-state'

export interface WorkTree {
  nodes: { [key: string]: WorkItemState<WorkNode, NodeState> }
  services: { [key: string]: WorkItemState<WorkService, ServiceState> }
  environments: { [key: string]: WorkEnvironment }
}
