import { number, object, string, union, z } from 'zod'
import { parseCpus, parseSize } from '../utils/units'

// Docker refuses a container with less memory than this
export const MIN_MEMORY_BYTES = 6 * 1024 ** 2

function isCpus(value: string | number): boolean {
  try {
    parseCpus(value)
    return true
  } catch {
    return false
  }
}

function isMemory(value: string): boolean {
  try {
    return parseSize(value) >= MIN_MEMORY_BYTES
  } catch {
    return false
  }
}

// CPU and memory limits in Kubernetes notation. Enforced on Docker and
// Kubernetes, a hint only for local tasks. Not part of the cache key (ADR-0002).
export const resourcesSchema = object({
  cpus: union([number(), string()])
    .refine(isCpus, (value) => ({
      message: `invalid cpus "${value}", expected cores or millicores, e.g. 2, 0.5 or 500m`,
    }))
    .optional(),
  memory: string()
    .refine(isMemory, (value) => ({
      message: `invalid memory "${value}", expected at least 6Mi, e.g. 512Mi or 2Gi`,
    }))
    .optional(),
})
  .strict()
  .describe('cpu and memory limits')

export type ResourcesSchema = z.infer<typeof resourcesSchema>
