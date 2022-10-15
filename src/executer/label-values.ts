import { WorkNode } from '../planner/work-node'
import { WorkNodes } from '../planner/work-nodes'

export interface LabelValues {
  [key: string]: string[]
}

export function matchesAllLabels(filterLabels: LabelValues, node: WorkNode, nodes: WorkNodes): boolean {
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

export function hasNeedsWithMatch(root: WorkNode, nodes: WorkNodes, matcher: (node: WorkNode) => boolean): boolean {
  for (const node of Object.values(nodes)) {
    if (node.deps.some((d) => d.id === root.id)) {
      if (matcher(node)) {
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
