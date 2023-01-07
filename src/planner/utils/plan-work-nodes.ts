import { BuildFile } from '../../parser/build-file'
import { WorkNodes } from '../work-nodes'
import { WorkNode } from '../work-node'
import { WorkServices } from '../work-services'
import { WorkService } from '../work-service'
import { NodeState } from '../../executer/scheduler/node-state'
import { ServiceState } from '../../executer/scheduler/service-state'
import { SchedulerNodeState, SchedulerServiceState } from '../../executer/scheduler/scheduler-state'
import { getWorkNode } from './plan-work-node'
import { WorkTree } from '../work-tree'
import { createSubWorkContext, createWorkContext, WorkContext } from '../work-context'
import { WorkLabelScope } from '../../executer/work-scope'
import { matchesAllLabels, matchesAnyLabel } from '../../executer/label-values'

export function planWorkNodes(build: BuildFile, options: WorkLabelScope): WorkTree {
  const context = createWorkContext(build)
  addWorkNodes(context, [])

  const nodesIdsToRemove: string[] = []
  for (const [nodeId, node] of Object.entries(context.workTree.nodes)) {
    if (
      !matchesAllLabels(options.filterLabels, node, context.workTree.nodes) ||
      matchesAnyLabel(options.excludeLabels, node)
    ) {
      nodesIdsToRemove.push(nodeId)
    }
  }

  for (const nodeId of nodesIdsToRemove) {
    removeNode(nodeId, context.workTree)
  }

  removeUnusedServices(context.workTree)

  return context.workTree
}

function removeUnusedServices(workTree: WorkTree) {
  const needs = new Set<string>()
  for (const node of Object.values(workTree.nodes)) {
    for (const need of node.needs) {
      needs.add(need.id)
    }
  }

  const services = Object.values(workTree.services)
  for (const service of services) {
    if (!needs.has(service.id)) {
      delete workTree.services[service.id]
    }
  }
}

function removeNode(nodeId: string, workTree: WorkTree) {
  const node = workTree.nodes[nodeId]
  if (node) {
    delete workTree.nodes[nodeId]
    for (const node of Object.values(workTree.nodes)) {
      if (node.deps.some((d) => d.id === nodeId)) {
        removeNode(node.id, workTree)
      }
    }
  }
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

function addWorkNodes(context: WorkContext, files: string[]) {
  if (files.indexOf(context.build.fileName) !== -1) {
    return
  }

  files.push(context.build.fileName)
  for (const taskName of Object.keys(context.build.tasks)) {
    getWorkNode(context, { name: taskName })
  }

  for (const name of Object.keys(context.build.references)) {
    addWorkNodes(createSubWorkContext(context, { type: 'references', name }), files)
  }

  for (const name of Object.keys(context.build.includes)) {
    addWorkNodes(createSubWorkContext(context, { type: 'includes', name }), files)
  }
}
