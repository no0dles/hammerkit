import { LabelValues } from '../executer/label-values'

export function parseLabelArguments(args: string[]): LabelValues {
  const labels: LabelValues = {}

  for (const arg of args) {
    const labelParts = arg.split('=')
    if (labelParts.length !== 2) {
      throw new Error(`invalid label ${arg}`)
    }

    const key = labelParts[0]
    const value = labelParts[1]

    if (!labels[key]) {
      labels[key] = [value]
    } else if (labels[key].indexOf(value) === -1) {
      labels[key].push(value)
    }
  }

  return labels
}
