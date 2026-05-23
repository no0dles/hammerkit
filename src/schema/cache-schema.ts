import { literal, union, z } from 'zod'

export const cacheSchema = union([literal('checksum'), literal('modify-date'), literal('none')])

export type CacheSchema = z.infer<typeof cacheSchema>
