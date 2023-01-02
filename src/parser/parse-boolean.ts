import { ParseContext, parseContextDescription } from './parse-context'

export function parseBoolean(ctx: ParseContext, name: string, value: unknown, optional: false): boolean
export function parseBoolean(ctx: ParseContext, name: string, value: unknown, optional: true): boolean | null
export function parseBoolean(ctx: ParseContext, name: string, value: unknown, optional: boolean): boolean | null
export function parseBoolean(ctx: ParseContext, name: string, value: unknown, optional: boolean): boolean | null {
  if (value == null || value === undefined) {
    if (optional) {
      return null
    } else {
      throw new Error(`${parseContextDescription(ctx)} -> ${name} is missing boolean`)
    }
  }

  if (typeof value === 'boolean') {
    return value
  } else if (typeof value === 'string') {
    const lowerCaseValue = value.toLowerCase()
    if (lowerCaseValue === 'true') {
      return true
    } else if (lowerCaseValue === 'false') {
      return false
    }
  }

  throw new Error(`${parseContextDescription(ctx)} -> ${name} invalid boolean "${value}"`)
}
