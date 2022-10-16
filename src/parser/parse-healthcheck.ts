import { ParseContext, parseContextDescription } from './parse-context'
import { ExecutionBuildServiceHealthCheck } from './build-file-service'
import { parseString } from './parse-string'

export function parseHealthcheck(ctx: ParseContext, value: unknown): ExecutionBuildServiceHealthCheck | null {
  if (typeof value !== 'object') {
    throw new Error(`${parseContextDescription(ctx)} invalid healthcheck, expecting map`)
  }

  if (value === null || value === undefined) {
    return null
  }

  if (!('cmd' in value)) {
    throw new Error(`${parseContextDescription(ctx)} invalid healthcheck, missing cmd property`)
  }

  const result: ExecutionBuildServiceHealthCheck = { cmd: '' }
  for (const [key, prop] of Object.entries(value)) {
    if (key === 'cmd') {
      result.cmd = parseString(ctx, 'healthcheck cmd', prop, false)
    } else {
      throw new Error(`${parseContextDescription(ctx)} unknown property ${key} in healthcheck`)
    }
  }

  return result
}
