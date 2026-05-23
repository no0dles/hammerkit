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

export const cacheBackendNoopSchema = object({
  type: literal('noop'),
}).strict()
export type CacheBackendNoopSchema = z.infer<typeof cacheBackendNoopSchema>

export const cacheBackendSchema = union([cacheBackendLocalSchema, cacheBackendS3Schema, cacheBackendNoopSchema])
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
