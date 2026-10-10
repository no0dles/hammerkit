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

const cpusSchema = union([number(), string()]).refine(isCpus, (value) => ({
  message: `invalid cpus "${value}", expected cores or millicores, e.g. 2, 0.5 or 500m`,
}))

const memorySchema = string().refine(isMemory, (value) => ({
  message: `invalid memory "${value}", expected at least 6Mi, e.g. 512Mi or 2Gi`,
}))

const quantitiesSchema = object({
  cpus: cpusSchema.optional(),
  memory: memorySchema.optional(),
}).strict()

export type ResourceQuantitiesSchema = z.infer<typeof quantitiesSchema>

// CPU and memory in Kubernetes notation: `{cpus, memory}` limits the
// container and requests the same, `{requests, limits}` sets them apart (a
// request without a limit is not capped). Requests are what the run schedules
// by. Not part of the cache key (ADR-0002).
export const resourcesSchema = object({
  cpus: cpusSchema.optional(),
  memory: memorySchema.optional(),
  requests: quantitiesSchema.optional(),
  limits: quantitiesSchema.optional(),
})
  .strict()
  .superRefine((value, ctx) => {
    const shorthand = value.cpus !== undefined || value.memory !== undefined
    if (shorthand && (value.requests || value.limits)) {
      ctx.addIssue({
        code: 'custom',
        message: 'set either cpus/memory or requests/limits, not both',
      })
      return
    }
    for (const key of ['cpus', 'memory'] as const) {
      const request = value.requests?.[key]
      const limit = value.limits?.[key]
      if (request === undefined || limit === undefined || !isQuantity(key, request) || !isQuantity(key, limit)) {
        continue
      }
      if (parseQuantity(key, request) > parseQuantity(key, limit)) {
        ctx.addIssue({
          code: 'custom',
          path: ['requests', key],
          message: `requested ${key} ${request} exceeds the limit ${limit}`,
        })
      }
    }
  })
  .describe('cpu and memory requests and limits')

function isQuantity(key: 'cpus' | 'memory', value: string | number): boolean {
  return key === 'cpus' ? isCpus(value) : typeof value === 'string' && isMemory(value)
}

function parseQuantity(key: 'cpus' | 'memory', value: string | number): number {
  return key === 'cpus' ? parseCpus(value) : parseSize(`${value}`)
}

export type ResourcesSchema = z.infer<typeof resourcesSchema>
