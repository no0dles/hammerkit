import { CacheBackendSchema } from '../schema/cache-schema'
import { Environment } from '../executer/environment'

// One stored cache entry, addressed by task id + state key. Numeric fields are
// `null` when the backend cannot supply them (so the caller can report the
// corresponding retention policy as unavailable rather than silently ignore it).
export interface CacheEntry {
  taskId: string
  stateKey: string
  // total entry size in bytes
  size: number | null
  // epoch ms the entry was written
  createdAt: number | null
  // epoch ms of the last cache hit (hammerkit-owned marker, never OS atime)
  lastAccessedAt: number | null
}

export interface CacheBackend {
  readonly type: string

  has(taskId: string, stateKey: string, environment: Environment): Promise<boolean>

  pull(taskId: string, stateKey: string, into: string, environment: Environment): Promise<boolean>

  push(taskId: string, stateKey: string, from: string, environment: Environment): Promise<void>

  /** Remove every cached entry for a task (all state keys). */
  clear(taskId: string, environment: Environment): Promise<void>

  /**
   * Enumerate stored entries for retention/inspection. Optional: a backend that
   * cannot enumerate omits it, and callers report introspection as unavailable.
   */
  list?(environment: Environment): Promise<CacheEntry[]>

  /**
   * Remove a single entry (one task id + state key). Optional: a backend that
   * cannot delete a single entry omits it. Used by `cache prune`.
   */
  remove?(taskId: string, stateKey: string, environment: Environment): Promise<void>
}

export type CacheBackendFactory = (spec: CacheBackendSchema) => CacheBackend
