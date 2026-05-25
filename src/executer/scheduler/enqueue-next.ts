import { getStateKey, getWorkCacheStats } from '../../optimizer/get-work-cache-stats'
import { Environment } from '../environment'
import { CacheMethod } from '../../parser/cache-method'
import { isWorkTaskItem, WorkItemState } from '../../planner/work-item'
import { WorkTask } from '../../planner/work-task'
import { WorkService } from '../../planner/work-service'
import { ResolvedCache } from '../../cache/resolve-cache'
import { getCacheDirectory } from '../../optimizer/get-cache-directory'
import { writeCacheMetadata } from '../cache-metadata'
import { getWorkTaskCacheDescription } from '../../optimizer/work-task-cache-description'
import { getErrorMessage } from '../../log'
import { createHash } from 'crypto'

export interface CacheState {
  cached: boolean
  stateKey: string
  resolved: ResolvedCache
}

function resolveEffective(
  item: WorkItemState<WorkTask | WorkService, any>,
  fallbackMethod: CacheMethod
): ResolvedCache {
  const declared = item.data.caching
  if (declared.implicit) {
    return { ...declared, method: fallbackMethod }
  }
  return declared
}

// Fold a task's own state key together with the state keys of its dependencies.
// A change anywhere in the dependency subtree must change the resulting key, so
// that a downstream task is invalidated when an upstream source changes — even
// if the downstream task's own sources are untouched.
function combineStateKeys(ownKey: string, depKeys: string[]): string {
  if (depKeys.length === 0) {
    return ownKey
  }
  // Sort so the key is independent of dependency declaration order.
  const sorted = [...depKeys].sort()
  return createHash('md5')
    .update([ownKey, ...sorted].join(','))
    .digest('hex')
}

// Compute an item's effective state key from its source files plus the effective
// state keys of its dependencies, recursively. This is derived purely from the
// work tree and the filesystem, so it does not depend on scheduler/run state —
// important because checkCacheState runs before dependencies are awaited.
async function resolveEffectiveStateKey(
  item: WorkItemState<WorkTask | WorkService, any>,
  defaultCacheMethod: CacheMethod,
  environment: Environment,
  memo: Map<string, string>
): Promise<string> {
  const existing = memo.get(item.id())
  if (existing !== undefined) {
    return existing
  }

  const resolved = resolveEffective(item, defaultCacheMethod)
  // Always hash with a concrete method; `none` only disables the cache *check*
  // for that task, its sources still influence what depends on it.
  const method = resolved.method === 'none' ? defaultCacheMethod : resolved.method
  const stats = await getWorkCacheStats(item.data, environment)
  const ownKey = getStateKey(stats, method)

  const depKeys: string[] = []
  for (const dep of item.deps) {
    depKeys.push(await resolveEffectiveStateKey(dep, defaultCacheMethod, environment, memo))
  }

  const combined = combineStateKeys(ownKey, depKeys)
  memo.set(item.id(), combined)
  return combined
}

export async function checkCacheState(
  item: WorkItemState<WorkTask | WorkService, any>,
  defaultCacheMethod: CacheMethod,
  environment: Environment
): Promise<CacheState> {
  const resolved = resolveEffective(item, defaultCacheMethod)

  const currentStats = await getWorkCacheStats(item.data, environment)
  const ownKey = getStateKey(currentStats, resolved.method === 'none' ? defaultCacheMethod : resolved.method)
  const memo = new Map<string, string>()
  const depKeys: string[] = []
  for (const dep of item.deps) {
    depKeys.push(await resolveEffectiveStateKey(dep, defaultCacheMethod, environment, memo))
  }
  const stateKey = combineStateKeys(ownKey, depKeys)

  if (resolved.method === 'none') {
    item.status.write('debug', `${item.name} is skipping cache check, because caching is disabled`)
    return { cached: false, stateKey, resolved }
  }

  if (isWorkTaskItem(item)) {
    const runtimeStateKey = await item.runtime.currentStateKey(environment)

    if (runtimeStateKey === stateKey) {
      return { cached: true, stateKey, resolved }
    }

    try {
      const cacheDir = getCacheDirectory(item.id())
      const pulled = await resolved.backend.pull(item.id(), stateKey, cacheDir, environment)
      if (pulled) {
        item.status.write('info', `${item.name} pulled from cache "${resolved.name}" (${resolved.backend.type})`)
        await item.runtime.restore(environment, cacheDir)
        await writeCacheMetadata(environment, item.id(), currentStats, getWorkTaskCacheDescription(item.data))
        return { cached: true, stateKey, resolved }
      }
    } catch (e) {
      item.status.write(
        'warn',
        `${item.name} failed to pull from cache "${resolved.name}": ${getErrorMessage(
          e
        )} — continuing with local execution`
      )
    }
  }

  return { cached: false, stateKey, resolved }
}
