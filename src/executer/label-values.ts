import { WorkLabelScope } from './work-scope'

export interface LabelValues {
  [key: string]: string[]
}

export function hasLabels(labels: LabelValues) {
  return Object.keys(labels).length > 0
}

export function matchesAnyLabel(filter: LabelValues, value: LabelValues): boolean {
  for (const [labelKey, filterValues] of Object.entries(filter)) {
    const labelValues = value[labelKey]
    if (labelValues === null || labelValues === undefined || labelValues.length === 0) {
      continue
    }

    for (const labelValue of labelValues) {
      if (filterValues.indexOf(labelValue) >= 0) {
        return true
      }
    }
  }

  return false
}

export function appliesToLabels(labels: LabelValues, options: WorkLabelScope): boolean {
  return (
    (!hasLabels(options.filterLabels ?? {}) || matchesAnyLabel(options.filterLabels ?? {}, labels)) &&
    !matchesAnyLabel(options.excludeLabels ?? {}, labels)
  )
}

export function mergeLabels(
  ...sources: ({ [key: string]: string | number | string[] } | null | undefined)[]
): LabelValues {
  const result: LabelValues = {}

  for (const source of sources) {
    for (const [key, value] of Object.entries(source || {})) {
      const arrayValue = value instanceof Array ? value : [`${value}`]
      if (!result[key]) {
        result[key] = arrayValue
      } else {
        for (const item of arrayValue) {
          if (result[key].indexOf(item) === -1) {
            result[key].push(item)
          }
        }
      }
    }
  }

  return result
}
