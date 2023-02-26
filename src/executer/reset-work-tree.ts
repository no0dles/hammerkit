import { WorkTree } from '../planner/work-tree'
import { WorkItemState } from '../planner/work-item'
import { WorkNode } from '../planner/work-node'
import { NodeState } from './scheduler/node-state'
import { State } from './state'
import { WorkService } from '../planner/work-service'
import { ServiceState } from './scheduler/service-state'

export function resetWorkTree(workTree: WorkTree): WorkTree {
  return {
    nodes: Object.entries(workTree.nodes).reduce<{ [key: string]: WorkItemState<WorkNode, NodeState> }>(
      (nodes, [key, node]) => {
        node.state = new State<NodeState>({
          type: 'pending',
          stateKey: null,
        })
        nodes[key] = node
        return nodes
      },
      {}
    ),
    services: Object.entries(workTree.services).reduce<{
      [key: string]: WorkItemState<WorkService, ServiceState>
    }>((services, [key, service]) => {
      service.state = new State<ServiceState>({
        type: 'pending',
        stateKey: null,
      })
      services[key] = service
      return services
    }, {}),
    environments: workTree.environments,
  }
}
