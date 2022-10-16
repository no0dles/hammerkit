import { ParseContext, parseContextDescription } from './parse-context'

export function parseStringArray(ctx: ParseContext, valueName: string, value: unknown): string[] | null {
  if (!value) {
    return null
  }
  if (value instanceof Array) {
    if (!value.every((v) => typeof v === 'string' || typeof v === 'number')) {
      throw new Error(`${parseContextDescription(ctx)} ${valueName} needs to be a string array`)
    }
    return value.map((v) => `${v}`)
  } else {
    throw new Error(`${parseContextDescription(ctx)} ${valueName} needs to be a string array`)
  }
}
