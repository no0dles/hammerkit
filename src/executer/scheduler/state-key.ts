import { createHash } from 'crypto'
import { getStateKey, getWorkItemCacheStats } from '../../optimizer/get-work-cache-stats'
import { WorkCacheFileStats } from '../../optimizer/work-cache-stats'
import { Environment } from '../environment'
import { CacheMethod } from '../../parser/cache-method'
import { WorkItemState } from '../../planner/work-item'
import { WorkTask } from '../../planner/work-task'
import { WorkService } from '../../planner/work-service'
import { ResolvedCache } from '../../cache/resolve-cache'
import { WorkSource } from '../../planner/work-source'

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

// A task whose inputs cannot be observed cannot be proven up to date, so it
// always runs, and so does everything depending on it (specs/task SC-001). That
// is a task that declares no `src` of its own — the sources it inherits from its
// dependencies say nothing about the files its own commands read — and a task
// whose `src` entries all match no file (a typo, a moved path). Services are not
// affected.
function isOwnProvable(item: WorkItemState<WorkTask | WorkService, any>, unmatched: WorkSource[]): boolean {
  // unmatched ⊆ declared, so this is also false when nothing is declared
  return unmatched.length < item.data.src.filter((src) => !src.inherited).length
}

interface EffectiveStateKey {
  stateKey: string
  // false when the item or a dependency cannot be proven up to date
  provable: boolean
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
async function resolveEffectiveStateKey(
  item: WorkItemState<WorkTask | WorkService, any>,
  defaultCacheMethod: CacheMethod,
  environment: Environment,
  memo: Map<string, EffectiveStateKey>
): Promise<EffectiveStateKey> {
  const existing = memo.get(item.id())
  if (existing !== undefined) {
    return existing
  }

  const { stateKey, provable } = await computeStateKey(item, defaultCacheMethod, environment, memo)
  const effective = { stateKey, provable }
  memo.set(item.id(), effective)
  return effective
}

export interface StateKeyComputation {
  // The combined state key (own sources folded with dependency keys).
  stateKey: string
  // The source-file stats the own key was derived from.
  stats: WorkCacheFileStats
  resolved: ResolvedCache
  // Whether the item can be proven up to date at all (see isOwnProvable); an
  // unprovable task always runs and is never stored in or taken from a cache.
  provable: boolean
  // declared src entries that match no file
  unmatched: WorkSource[]
}

// Compute the combined state key for a single item together with the source
// stats it was derived from, sharing one filesystem walk with callers that also
// need the stats (the scheduler, the explain engine).
export async function computeStateKey(
  item: WorkItemState<WorkTask | WorkService, any>,
  defaultCacheMethod: CacheMethod,
  environment: Environment,
  memo: Map<string, EffectiveStateKey> = new Map()
): Promise<StateKeyComputation> {
  const resolved = resolveEffective(item, defaultCacheMethod)
  const { stats, unmatched } = await getWorkItemCacheStats(item, environment)
  const ownKey = getStateKey(stats, concreteMethod(resolved, defaultCacheMethod))

  const depKeys: string[] = []
  let provable = isOwnProvable(item, unmatched)
  for (const dep of item.deps) {
    const effective = await resolveEffectiveStateKey(dep, defaultCacheMethod, environment, memo)
    depKeys.push(effective.stateKey)
    provable = provable && effective.provable
  }

  return { stateKey: combineStateKeys(ownKey, depKeys), stats, resolved, provable, unmatched }
}
