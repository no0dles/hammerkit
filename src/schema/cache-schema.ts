import { literal, object, string, union, z } from 'zod'

export const cacheMethodSchema = union([literal('checksum'), literal('modify-date'), literal('none')])
export type CacheMethodSchema = z.infer<typeof cacheMethodSchema>

export const cacheBackendLocalSchema = object({
  type: literal('local'),
  path: string().optional(),
}).strict()
export type CacheBackendLocalSchema = z.infer<typeof cacheBackendLocalSchema>

export const cacheBackendS3Schema = object({
  type: literal('s3'),
  bucket: string(),
  region: string().optional(),
  endpoint: string().optional(),
  prefix: string().optional(),
  forcePathStyle: z.boolean().optional(),
}).strict()
export type CacheBackendS3Schema = z.infer<typeof cacheBackendS3Schema>

export const cacheBackendRegistrySchema = object({
  type: literal('registry'),
  // repository to store entries in, e.g. `ghcr.io/org/hammerkit-cache`
  repository: string(),
  // talk plain http (defaults to true only for localhost registries)
  insecure: z.boolean().optional(),
}).strict()
export type CacheBackendRegistrySchema = z.infer<typeof cacheBackendRegistrySchema>

export const cacheBackendSchema = union([cacheBackendLocalSchema, cacheBackendS3Schema, cacheBackendRegistrySchema])
export type CacheBackendSchema = z.infer<typeof cacheBackendSchema>

export const buildFileCacheSchema = object({
  method: cacheMethodSchema,
  backend: cacheBackendSchema,
}).strict()
export type BuildFileCacheSchema = z.infer<typeof buildFileCacheSchema>

export const taskCacheRefSchema = union([
  cacheMethodSchema,
  object({
    name: string(),
    method: cacheMethodSchema.optional(),
  }).strict(),
])
export type TaskCacheRefSchema = z.infer<typeof taskCacheRefSchema>

export const cacheSchema = taskCacheRefSchema
export type CacheSchema = TaskCacheRefSchema
