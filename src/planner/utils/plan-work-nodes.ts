import { WorkNodes } from '../work-nodes'
import { WorkServices } from '../work-services'
import { NodeState } from '../../executer/scheduler/node-state'
import { ServiceState } from '../../executer/scheduler/service-state'
import { SchedulerNodeState, SchedulerServiceState } from '../../executer/scheduler/scheduler-state'
import { WorkItem } from '../work-item'
import { WorkNode } from '../work-node'
import { WorkService } from '../work-service'

export function iterateWorkServices(services: WorkServices): Generator<WorkItem<WorkService>>
export function iterateWorkServices(services: SchedulerServiceState): Generator<ServiceState>
export function* iterateWorkServices(
  services: WorkServices | SchedulerServiceState
): Generator<WorkItem<WorkService> | ServiceState> {
  for (const serviceId of Object.keys(services)) {
    const service = services[serviceId]
    yield service
  }
}

export function iterateWorkNodes(nodes: WorkNodes): Generator<WorkItem<WorkNode>>
export function iterateWorkNodes(nodes: SchedulerNodeState): Generator<NodeState>
export function* iterateWorkNodes(nodes: WorkNodes | SchedulerNodeState): Generator<WorkItem<WorkNode> | NodeState> {
  for (const nodeId of Object.keys(nodes)) {
    const node = nodes[nodeId]
    yield node
  }
}
