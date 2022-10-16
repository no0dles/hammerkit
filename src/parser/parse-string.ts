import { ParseContext, parseContextDescription } from './parse-context'

export function parseString(ctx: ParseContext, keyName: string, value: unknown, optional: false): string
export function parseString(ctx: ParseContext, keyName: string, value: unknown, optional: true): string | null
export function parseString(ctx: ParseContext, keyName: string, value: unknown, optional: boolean): string | null
export function parseString(ctx: ParseContext, keyName: string, value: unknown, optional: boolean): string | null {
  if (value === null || value === undefined) {
    if (optional) {
      return null
    } else {
      throw new Error(`${parseContextDescription(ctx)} -> ${keyName} is missing`)
    }
  }

  if (typeof value === 'string' || typeof value === 'number') {
    return `${value}`
  }

  throw new Error(`${parseContextDescription(ctx)} -> ${keyName} is not a valid string`)
}
