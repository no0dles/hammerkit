import { CacheBackend } from './cache-backend'
import { BuildFileCacheSchema, CacheMethodSchema, TaskCacheRefSchema } from '../schema/cache-schema'
import { createCacheBackend } from './cache-backend-registry'

export interface ResolvedCache {
  name: string
  method: CacheMethodSchema
  backend: CacheBackend
  // true when no `cache:` was declared on the task; lets the CLI `--cache <method>`
  // flag override the method for tasks that didn't opt in explicitly.
  implicit: boolean
}

export const DEFAULT_CACHE_NAME = 'default'
export const NONE_CACHE_NAME = 'none'

// `default` keeps today's behaviour: state lives per-cwd via the runtime (e.g.
// `.hammerkit/<task-id>` files or container labels) and nothing is pushed/pulled
// across machines. To opt into a shared cache, redeclare `caches.default` or
// add a named cache backed by `local`/`s3`/etc and reference it from the task.
export const builtinCaches: { [name: string]: BuildFileCacheSchema } = {
  [DEFAULT_CACHE_NAME]: { method: 'checksum', backend: { type: 'noop' } },
  [NONE_CACHE_NAME]: { method: 'none', backend: { type: 'noop' } },
}

export interface CacheCatalog {
  [name: string]: BuildFileCacheSchema
}

export function withBuiltinCaches(declared: CacheCatalog | undefined): CacheCatalog {
  const merged: CacheCatalog = { ...builtinCaches }
  if (declared) {
    for (const [name, value] of Object.entries(declared)) {
      merged[name] = value
    }
  }
  return merged
}

const backendInstances = new WeakMap<BuildFileCacheSchema, CacheBackend>()

function getBackend(spec: BuildFileCacheSchema): CacheBackend {
  let instance = backendInstances.get(spec)
  if (!instance) {
    instance = createCacheBackend(spec.backend)
    backendInstances.set(spec, instance)
  }
  return instance
}

function isMethodShorthand(value: TaskCacheRefSchema | undefined): value is CacheMethodSchema {
  return typeof value === 'string'
}

export function resolveCache(
  ref: TaskCacheRefSchema | undefined | null,
  catalog: CacheCatalog,
  taskName: string
): ResolvedCache {
  if (ref === undefined || ref === null) {
    return resolveByName(DEFAULT_CACHE_NAME, undefined, catalog, taskName, true)
  }
  if (isMethodShorthand(ref)) {
    return resolveByName(DEFAULT_CACHE_NAME, ref, catalog, taskName, false)
  }
  return resolveByName(ref.name, ref.method, catalog, taskName, false)
}

function resolveByName(
  name: string,
  methodOverride: CacheMethodSchema | undefined,
  catalog: CacheCatalog,
  taskName: string,
  implicit: boolean
): ResolvedCache {
  const spec = catalog[name]
  if (!spec) {
    throw new Error(`cache "${name}" referenced by task "${taskName}" is not defined`)
  }
  return {
    name,
    method: methodOverride ?? spec.method,
    backend: getBackend(spec),
    implicit,
  }
}
