import { CacheBackend } from '../cache-backend'

export function createNoopCacheBackend(): CacheBackend {
  return {
    type: 'noop',
    async has(): Promise<boolean> {
      return false
    },
    async pull(): Promise<boolean> {
      return false
    },
    async push(): Promise<void> {
      // no-op
    },
  }
}
