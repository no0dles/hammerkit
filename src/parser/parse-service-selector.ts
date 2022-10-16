import { ParseContext, parseContextDescription } from './parse-context'
import { ExecutionBuildServiceSelector } from './build-file-service'
import { parseString } from './parse-string'

export function parseServiceSelector(
  ctx: ParseContext,
  value: unknown,
  optional: boolean
): ExecutionBuildServiceSelector | null {
  if (typeof value !== 'object') {
    throw new Error(`${parseContextDescription(ctx)} invalid selector, expecting map`)
  }

  if (value === null || value === undefined) {
    if (optional) {
      return null
    } else {
      throw new Error(`${parseContextDescription(ctx)} missing selector`)
    }
  }

  if (!('type' in value)) {
    throw new Error(`${parseContextDescription(ctx)} invalid selector, missing type property`)
  }
  if (!('name' in value)) {
    throw new Error(`${parseContextDescription(ctx)} invalid selector, missing name property`)
  }

  const result: ExecutionBuildServiceSelector = { type: '', name: '' }
  for (const [key, prop] of Object.entries(value)) {
    if (key === 'type') {
      result.type = parseString(ctx, 'selector type', prop, false)
    } else if (key === 'name') {
      result.type = parseString(ctx, 'selector name', prop, false)
    } else {
      throw new Error(`${parseContextDescription(ctx)} unknown property ${key} in healthcheck`)
    }
  }

  return result
}
