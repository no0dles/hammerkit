import { BuildFile } from '../../parser/build-file'
import { WorkNodes } from '../work-nodes'
import { WorkNode } from '../work-node'
import { WorkServices } from '../work-services'
import { WorkService } from '../work-service'
import { NodeState } from '../../executer/scheduler/node-state'
import { ServiceState } from '../../executer/scheduler/service-state'
import { SchedulerNodeState, SchedulerServiceState } from '../../executer/scheduler/scheduler-state'
import { ExecTargetLabel, LabelValues } from '../../testing/test-suite'
import { getWorkNode } from './plan-work-node'
import { WorkTree } from '../work-tree'
import { CacheMethod } from '../../parser/cache-method'
import { createSubWorkContext, createWorkContext, WorkContext } from '../work-context'

function matchesAllLabels(filterLabels: LabelValues, node: WorkNode, nodes: WorkNodes): boolean {
  for (const [labelKey, filterValues] of Object.entries(filterLabels)) {
    const nodeValues = node.labels[labelKey]
    if (nodeValues === null || nodeValues === undefined || nodeValues.length === 0) {
      if (!hasNeedsWithMatch(node, nodes, (depNode) => matchesAllLabels(filterLabels, depNode, nodes))) {
        return false
      }
    }

    for (const nodeValue of nodeValues) {
      if (filterValues.indexOf(nodeValue) === -1) {
        if (!hasNeedsWithMatch(node, nodes, (depNode) => matchesAllLabels(filterLabels, depNode, nodes))) {
          return false
        }
      }
    }
  }

  return true
}

function hasNeedsWithMatch(root: WorkNode, nodes: WorkNodes, matcher: (node: WorkNode) => boolean): boolean {
  for (const node of Object.values(nodes)) {
    if (node.deps.some((d) => d.id === root.id)) {
      if (matcher(node)) {
        return true
      }
    }
  }
  return false
}

function hasDependencyWithMatch(root: WorkNode, matcher: (node: WorkNode) => boolean): boolean {
  for (const dep of root.deps) {
    if (matcher(dep)) {
      return true
    }
  }
  return false
}

function matchesAnyLabel(filterLabels: LabelValues, node: WorkNode): boolean {
  if (Object.keys(filterLabels).length === 0) {
    return false
  }

  for (const [labelKey, filterValues] of Object.entries(filterLabels)) {
    const nodeValues = node.labels[labelKey]
    if (nodeValues === null || nodeValues === undefined || nodeValues.length === 0) {
      continue
    }

    for (const nodeValue of nodeValues) {
      if (filterValues.indexOf(nodeValue) >= 0) {
        return true
      }
    }
  }

  return hasDependencyWithMatch(node, (depNode) => matchesAnyLabel(filterLabels, depNode))
}

export function planWorkNodes(
  build: BuildFile,
  options: ExecTargetLabel & { cache?: CacheMethod; noContainer: boolean }
): WorkTree {
  const context = createWorkContext(build, options.cache ?? null)
  addWorkNodes(context, [], options.noContainer)

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

  return context.workTree
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

function addWorkNodes(context: WorkContext, files: string[], noContainer: boolean) {
  if (files.indexOf(context.build.fileName) !== -1) {
    return
  }

  files.push(context.build.fileName)
  for (const taskName of Object.keys(context.build.tasks)) {
    getWorkNode(context, { taskName }, noContainer)
  }

  for (const name of Object.keys(context.build.references)) {
    addWorkNodes(createSubWorkContext(context, { type: 'references', name }), files, noContainer)
  }

  for (const name of Object.keys(context.build.includes)) {
    addWorkNodes(createSubWorkContext(context, { type: 'includes', name }), files, noContainer)
  }
}
