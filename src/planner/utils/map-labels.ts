import { LabelValues } from '../../executer/label-values'

export function mapLabels(labels: { [key: string]: string }): LabelValues {
  const result: LabelValues = {}
  for (const [key, value] of Object.entries(labels)) {
    result[key] = [value]
  }
  return result
}
