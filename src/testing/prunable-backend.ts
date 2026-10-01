import { CacheBackend } from '../cache/cache-backend'

export type PrunableBackend = CacheBackend & Required<Pick<CacheBackend, 'list' | 'remove'>>

function isPrunable(backend: CacheBackend): backend is PrunableBackend {
  return !!backend.list && !!backend.remove
}

// `list`/`remove` are optional on a cache backend; a retention test needs them
// and fails loudly when the backend under test lacks them.
export function prunable(backend: CacheBackend): PrunableBackend {
  if (!isPrunable(backend)) {
    throw new Error(`the ${backend.type} cache backend cannot list or remove entries`)
  }
  return backend
}
