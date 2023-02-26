import { WorkItemState } from '../work-item'
import { WorkNode } from '../work-node'
import { WorkService } from '../work-service'
import { WorkTree } from '../work-tree'
import { ServiceState } from '../../executer/scheduler/service-state'
import { NodeState } from '../../executer/scheduler/node-state'

export function* iterateWorkServices(workTree: WorkTree): Generator<WorkItemState<WorkService, ServiceState>> {
  for (const service of Object.values(workTree.services)) {
    yield service
  }
}

export function* iterateWorkNodes(workTree: WorkTree): Generator<WorkItemState<WorkNode, NodeState>> {
  for (const node of Object.values(workTree.nodes)) {
    yield node
  }
}

export function hasErrorTask(workTree: WorkTree): boolean {
  for (const node of iterateWorkNodes(workTree)) {
    if (node.state.current.type === 'error') {
      return true
    }
  }
  return false
}

export function hasErrorService(workTree: WorkTree): boolean {
  for (const node of iterateWorkServices(workTree)) {
    if (node.state.current.type === 'error') {
      return true
    }
  }
  return false
}

export function hasError(workTree: WorkTree): boolean {
  if (hasErrorService(workTree)) {
    return true
  }
  if (hasErrorTask(workTree)) {
    return true
  }
  return false
}
