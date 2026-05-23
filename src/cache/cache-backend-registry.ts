import { CacheBackendSchema } from '../schema/cache-schema'
import { CacheBackend, CacheBackendFactory } from './cache-backend'
import { createLocalCacheBackend } from './backends/local-cache-backend'
import { createNoopCacheBackend } from './backends/noop-cache-backend'
import { createS3CacheBackend } from './backends/s3-cache-backend'

const factories = new Map<string, CacheBackendFactory>()

export function registerCacheBackend(type: string, factory: CacheBackendFactory): void {
  factories.set(type, factory)
}

export function createCacheBackend(spec: CacheBackendSchema): CacheBackend {
  const factory = factories.get(spec.type)
  if (!factory) {
    throw new Error(`unknown cache backend type: ${spec.type}`)
  }
  return factory(spec)
}

registerCacheBackend('local', (spec) => createLocalCacheBackend(spec as { type: 'local'; path?: string }))
registerCacheBackend('noop', () => createNoopCacheBackend())
registerCacheBackend('s3', (spec) =>
  createS3CacheBackend(
    spec as {
      type: 's3'
      bucket: string
      region?: string
      endpoint?: string
      prefix?: string
      forcePathStyle?: boolean
    }
  )
)
