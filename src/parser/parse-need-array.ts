import { ParseContext, parseContextDescription } from './parse-context'
import { ExecutionServiceNeed } from './build-file-service'
import { parseString } from './parse-string'

export function parseNeedArray(ctx: ParseContext, valueName: string, value: unknown): ExecutionServiceNeed[] | null {
  if (!value) {
    return null
  }
  if (value instanceof Array) {
    const result: ExecutionServiceNeed[] = []
    for (const item of value) {
      if (typeof item === 'string') {
        result.push({ name: item, service: item })
      } else {
        result.push({
          name: parseString(ctx, `${valueName}.name`, item.name, false),
          service: parseString(ctx, `${valueName}.service`, item.service, false),
        })
      }
    }

    return result
  } else {
    throw new Error(`${parseContextDescription(ctx)} ${valueName} needs to be an array`)
  }
}
