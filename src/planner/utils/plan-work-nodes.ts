import { BuildFile } from '../../parser/build-file'
import { WorkNodes } from '../work-nodes'
import { planWorkNode } from './plan-work-node'
import { WorkNode } from '../work-node'
import { WorkServices } from '../work-services'
import { WorkService } from '../work-service'
import { NodeState } from '../../executer/scheduler/node-state'
import { ServiceState } from '../../executer/scheduler/service-state'
import { SchedulerNodeState, SchedulerServiceState } from '../../executer/scheduler/scheduler-state'
import { ExecTargetLabel, LabelValues } from '../../testing/test-suite'

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

export function planWorkNodes(build: BuildFile, target: ExecTargetLabel): [WorkNodes, WorkServices] {
  const nodes: WorkNodes = {}
  const services: WorkServices = {}
  addWorkNodes(build, nodes, services, [], [])

  const nodesIdsToRemove: string[] = []
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (!matchesAllLabels(target.filterLabels, node, nodes) || matchesAnyLabel(target.excludeLabels, node)) {
      nodesIdsToRemove.push(nodeId)
    }
  }

  for (const nodeId of nodesIdsToRemove) {
    removeNode(nodeId, nodes, services)
  }

  return [nodes, services]
}

function removeNode(nodeId: string, nodes: WorkNodes, services: WorkServices) {
  const node = nodes[nodeId]
  if (node) {
    delete nodes[nodeId]
    for (const node of Object.values(nodes)) {
      if (node.deps.some((d) => d.id === nodeId)) {
        removeNode(node.id, nodes, services)
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
    planWorkNode(build, taskId, nodes, services, {
      currentWorkdir: build.path,
      idPrefix: null,
      namePrefix: namePrefix,
    })
  }

  for (const key of Object.keys(build.references)) {
    addWorkNodes(build.references[key], nodes, services, files, [...namePrefix, key])
  }

  for (const key of Object.keys(build.includes)) {
    addWorkNodes(build.includes[key], nodes, services, files, [...namePrefix, key])
  }
}
