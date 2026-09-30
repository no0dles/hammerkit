import { createHash } from 'crypto'
import { getStateKey, getWorkCacheStats } from '../../optimizer/get-work-cache-stats'
import { WorkCacheFileStats } from '../../optimizer/work-cache-stats'
import { Environment } from '../environment'
import { CacheMethod } from '../../parser/cache-method'
import { WorkItemState } from '../../planner/work-item'
import { WorkTask } from '../../planner/work-task'
import { WorkService } from '../../planner/work-service'
import { ResolvedCache } from '../../cache/resolve-cache'

// The state-key engine is shared by the scheduler's hit/miss decision
// (`checkCacheState`) and the read-only cache-explain engine, so a prediction
// can never diverge from the decision it predicts — there is one implementation.

export function resolveEffective(
  item: WorkItemState<WorkTask | WorkService, any>,
  fallbackMethod: CacheMethod
): ResolvedCache {
  const declared = item.data.caching
  if (declared.implicit) {
    return { ...declared, method: fallbackMethod }
  }
  return declared
}

// A task without `src` cannot be proven up to date — its state key would be a
// constant — so it always runs, and so does everything depending on it
// (specs/task SC-001). Services are not affected.
export function isProvablyCacheable(item: WorkItemState<WorkTask | WorkService, any>): boolean {
  return item.data.src.length > 0 && item.deps.every((dep) => isProvablyCacheable(dep))
}

// Fold a task's own state key together with the state keys of its dependencies.
// A change anywhere in the dependency subtree must change the resulting key, so
// that a downstream task is invalidated when an upstream source changes — even
// if the downstream task's own sources are untouched.
export function combineStateKeys(ownKey: string, depKeys: string[]): string {
  if (depKeys.length === 0) {
    return ownKey
  }
  // Sort so the key is independent of dependency declaration order.
  const sorted = [...depKeys].sort()
  return createHash('md5')
    .update([ownKey, ...sorted].join(','))
    .digest('hex')
}

// `none` only disables the cache *check* for a task; its sources still influence
// what depends on it, so a concrete method is always used for the hash itself.
function concreteMethod(resolved: ResolvedCache, defaultCacheMethod: CacheMethod): CacheMethod {
  return resolved.method === 'none' ? defaultCacheMethod : resolved.method
}

// Compute an item's effective state key from its source files plus the effective
// state keys of its dependencies, recursively. This is derived purely from the
// work tree and the filesystem, so it does not depend on scheduler/run state —
// important because it runs before dependencies are awaited.
export async function resolveEffectiveStateKey(
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
  const stats = await getWorkCacheStats(item.data, environment)
  const ownKey = getStateKey(stats, concreteMethod(resolved, defaultCacheMethod))

  const depKeys: string[] = []
  for (const dep of item.deps) {
    depKeys.push(await resolveEffectiveStateKey(dep, defaultCacheMethod, environment, memo))
  }

  const combined = combineStateKeys(ownKey, depKeys)
  memo.set(item.id(), combined)
  return combined
}

export interface StateKeyComputation {
  // The combined state key (own sources folded with dependency keys).
  stateKey: string
  // The source-file stats the own key was derived from.
  stats: WorkCacheFileStats
  resolved: ResolvedCache
}

// Compute the combined state key for a single item together with the source
// stats it was derived from, sharing one filesystem walk with callers that also
// need the stats (the scheduler, the explain engine).
export async function computeStateKey(
  item: WorkItemState<WorkTask | WorkService, any>,
  defaultCacheMethod: CacheMethod,
  environment: Environment
): Promise<StateKeyComputation> {
  const resolved = resolveEffective(item, defaultCacheMethod)
  const stats = await getWorkCacheStats(item.data, environment)
  const ownKey = getStateKey(stats, concreteMethod(resolved, defaultCacheMethod))

  const memo = new Map<string, string>()
  const depKeys: string[] = []
  for (const dep of item.deps) {
    depKeys.push(await resolveEffectiveStateKey(dep, defaultCacheMethod, environment, memo))
  }

  return { stateKey: combineStateKeys(ownKey, depKeys), stats, resolved }
}
