import { string } from 'zod'
import { parseSize } from '../utils/units'

function isSize(value: string): boolean {
  try {
    parseSize(value)
    return true
  } catch {
    return false
  }
}

export const sizeSchema = string().refine(isSize, (value) => ({
  message: `invalid size "${value}", expected e.g. 500Mi, 5Gi or 2G`,
}))
