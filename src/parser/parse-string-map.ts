import { ParseContext, parseContextDescription } from './parse-context'

export function parseStringMap(ctx: ParseContext, valueName: string, value: unknown): { [key: string]: string } {
  if (value === null || value === undefined) {
    return {}
  }

  if (typeof value !== 'object') {
    throw new Error(`${parseContextDescription(ctx)} ${valueName} needs to be a string map`)
  }

  if (!value) {
    return {}
  }

  const map: { [key: string]: string } = {}

  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') {
      map[key] = item
    } else if (typeof item === 'number') {
      map[key] = item.toString()
    } else {
      throw new Error(`${parseContextDescription(ctx)} ${valueName} ${key} should be a string value`)
    }
  }

  return map
}
