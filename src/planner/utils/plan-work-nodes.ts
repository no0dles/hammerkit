import { BuildFile } from '../../parser/build-file'
import { WorkNodes } from '../work-nodes'
import { planWorkNode } from './plan-work-node'
import { WorkNode } from '../work-node'
import { WorkServices } from '../work-services'
import { WorkService } from '../work-service'
import { NodeState } from '../../executer/scheduler/node-state'
import { ServiceState } from '../../executer/scheduler/service-state'
import { SchedulerNodeState, SchedulerServiceState } from '../../executer/scheduler/scheduler-state'

export function planWorkNodes(build: BuildFile): [WorkNodes, WorkServices] {
  const nodes: WorkNodes = {}
  const services: WorkServices = {}
  addWorkNodes(build, nodes, services, [], [])
  return [nodes, services]
}

export function iterateWorkServices(services: WorkServices): Generator<WorkService>
export function iterateWorkServices(services: SchedulerServiceState): Generator<ServiceState>
export function* iterateWorkServices(
  services: WorkServices | SchedulerServiceState
): Generator<WorkService | ServiceState> {
  for (const serviceId of Object.keys(services)) {
    const service = services[serviceId]
    yield service
  }
}

export function iterateWorkNodes(nodes: WorkNodes): Generator<WorkNode>
export function iterateWorkNodes(nodes: SchedulerNodeState): Generator<NodeState>
export function* iterateWorkNodes(nodes: WorkNodes | SchedulerNodeState): Generator<WorkNode | NodeState> {
  for (const nodeId of Object.keys(nodes)) {
    const node = nodes[nodeId]
    yield node
  }
}

function addWorkNodes(
  build: BuildFile,
  nodes: WorkNodes,
  services: WorkServices,
  files: string[],
  namePrefix: string[]
) {
  if (files.indexOf(build.fileName) !== -1) {
    return
  }

  files.push(build.fileName)
  for (const taskId of Object.keys(build.tasks)) {
    planWorkNode(build, taskId, nodes, services, { currentWorkdir: build.path, idPrefix: null, namePrefix: namePrefix })
  }

  for (const key of Object.keys(build.references)) {
    addWorkNodes(build.references[key], nodes, services, files, [...namePrefix, key])
  }

  for (const key of Object.keys(build.includes)) {
    addWorkNodes(build.includes[key], nodes, services, files, [...namePrefix, key])
  }
}
