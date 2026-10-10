import { string } from 'zod'
import { parseDuration } from '../utils/units'

function isDuration(value: string): boolean {
  try {
    parseDuration(value)
    return true
  } catch {
    return false
  }
}

export const durationSchema = string().refine(isDuration, (value) => ({
  message: `invalid duration "${value}", expected e.g. 30s, 5m, 1h30m or 30d`,
}))
