import { WorkNode } from '../planner/work-node'
import { WorkTree } from '../planner/work-tree'
import { iterateWorkNodes, iterateWorkServices } from '../planner/utils/plan-work-nodes'
import { WorkService } from '../planner/work-service'

export interface LabelValues {
  [key: string]: string[]
}

export function hasLabels(labels: LabelValues) {
  return Object.keys(labels).length > 0
}

export function matchesAllLabels(filterLabels: LabelValues, node: WorkNode | WorkService, workTree: WorkTree): boolean {
  for (const [labelKey, filterValues] of Object.entries(filterLabels)) {
    const nodeValues = node.labels[labelKey]
    if (nodeValues === null || nodeValues === undefined || nodeValues.length === 0) {
      if (!hasNeedsWithMatch(node, workTree, (depNode) => matchesAllLabels(filterLabels, depNode, workTree))) {
        return false
      }
    }

    for (const nodeValue of nodeValues || []) {
      if (filterValues.indexOf(nodeValue) === -1) {
        if (!hasNeedsWithMatch(node, workTree, (depNode) => matchesAllLabels(filterLabels, depNode, workTree))) {
          return false
        }
      }
    }
  }

  return true
}

export function hasNeedsWithMatch(
  root: WorkNode | WorkService,
  workTree: WorkTree,
  matcher: (node: WorkNode | WorkService) => boolean
): boolean {
  for (const node of iterateWorkNodes(workTree.nodes)) {
    if (node.deps.some((d) => d.id === root.id)) {
      if (matcher(node)) {
        return true
      }
    }
  }
  for (const service of iterateWorkServices(workTree.services)) {
    if (service.deps.some((d) => d.id === root.id)) {
      if (matcher(service)) {
        return true
      }
    }
  }
  return false
}

export function hasDependencyWithMatch(root: WorkNode, matcher: (node: WorkNode) => boolean): boolean {
  for (const dep of root.deps) {
    if (matcher(dep)) {
      return true
    }
  }
  return false
}

export function matchesAnyLabel(filterLabels: LabelValues, node: WorkNode): boolean {
  if (!hasLabels(filterLabels)) {
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
