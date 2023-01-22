import { WorkLabelScope } from './work-scope'

export interface LabelValues {
  [key: string]: string[]
}

export function hasLabels(labels: LabelValues) {
  return Object.keys(labels).length > 0
}

export function matchesAllLabels(filter: LabelValues, value: LabelValues): boolean {
  for (const [labelKey, filterValues] of Object.entries(filter)) {
    const nodeValues = value[labelKey]
    for (const nodeValue of nodeValues || []) {
      if (filterValues.indexOf(nodeValue) === -1) {
        return false
      }
    }
  }

  return false
}

export function matchesAnyLabel(filter: LabelValues, value: LabelValues): boolean {
  for (const [labelKey, filterValues] of Object.entries(filter)) {
    const nodeValues = value[labelKey]
    if (nodeValues === null || nodeValues === undefined || nodeValues.length === 0) {
      continue
    }

    for (const nodeValue of nodeValues) {
      if (filterValues.indexOf(nodeValue) >= 0) {
        return true
      }
    }
  }

  return false
}

export function appliesToLabels(labels: LabelValues, options: WorkLabelScope): boolean {
  return (
    (Object.keys(options.filterLabels).length === 0 || matchesAnyLabel(options.filterLabels, labels)) &&
    !matchesAnyLabel(options.excludeLabels, labels)
  )
}
