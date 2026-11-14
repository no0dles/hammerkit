import { getStateKey, getWorkItemCacheStats, stateKeyDigest } from '../../optimizer/get-work-cache-stats'
import { WorkCacheFileStats } from '../../optimizer/work-cache-stats'
import { Environment } from '../environment'
import { CacheMethod } from '../../parser/cache-method'
import { WorkItem, WorkItemState } from '../../planner/work-item'
import { isAggregateTask, WorkTask } from '../../planner/work-task'
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
export function isOwnProvable(item: WorkItem<WorkTask | WorkService>, unmatched: WorkSource[]): boolean {
  if (isAggregateTask(item.data)) {
    // it runs nothing and reads nothing: what its dependencies prove is all there is
    return true
  }
  // unmatched ⊆ declared, so this is also false when nothing is declared
  return unmatched.length < item.data.src.filter((src) => !src.inherited).length
}

interface EffectiveStateKey {
  stateKey: string
  // false when the item or a dependency cannot be proven up to date
  provable: boolean
}

// The effective keys computed so far, by item id: a task's key folds in the keys of all it
// depends on, so without them the key of each dependency is computed again for every task
// above it (ci:check of 17 tasks hashed each file about ten times). It holds promises, so
// tasks checked at the same time share one computation, and only final keys: a key is
// never taken from a computation that has not finished.
export type StateKeyMemo = Map<string, Promise<EffectiveStateKey>>

// What an item on its own way down stands for. Items that depend on or need each other in a
// loop fail to plan (checkForLoop) and never run: this only has to end. The loop is told by
// the path of one computation, never by the shared memo, which tasks checked at the same time
// read, so a placeholder can never end up in another task's key.
const LOOP: EffectiveStateKey = { stateKey: 'loop', provable: true }

// Keep a computation in the memo, and take it out again if it fails, so a later check
// computes it anew instead of failing the same way.
function memoized(
  memo: StateKeyMemo,
  key: string,
  compute: () => Promise<EffectiveStateKey>
): Promise<EffectiveStateKey> {
  const existing = memo.get(key)
  if (existing) {
    return existing
  }
  const promise = compute()
  memo.set(key, promise)
  promise.catch(() => {
    if (memo.get(key) === promise) {
      memo.delete(key)
    }
  })
  return promise
}

const executionKeys = new WeakMap<object, StateKeyMemo>()

// The keys of one execution (the options of `exec`, which all its items share): its items
// are checked once, before they run, from the files as they are then. Not for watch mode,
// where a key is computed again because files changed.
export function getExecutionStateKeys(options: object): StateKeyMemo {
  let memo = executionKeys.get(options)
  if (!memo) {
    memo = new Map()
    executionKeys.set(options, memo)
  }
  return memo
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
  return stateKeyDigest([ownKey, ...sorted].join(','))
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
function resolveEffectiveStateKey(
  item: WorkItemState<WorkTask | WorkService, any>,
  defaultCacheMethod: CacheMethod,
  environment: Environment,
  memo: StateKeyMemo,
  path: ReadonlySet<string>
): Promise<EffectiveStateKey> {
  if (path.has(item.id())) {
    return Promise.resolve(LOOP)
  }
  return memoized(memo, item.id(), async () => {
    const { stateKey, provable } = await computeStateKey(item, defaultCacheMethod, environment, memo, path)
    return { stateKey, provable }
  })
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
  memo: StateKeyMemo = new Map(),
  // the items being computed on the way here, see LOOP
  parentPath: ReadonlySet<string> = new Set()
): Promise<StateKeyComputation> {
  const path = new Set(parentPath).add(item.id())
  const resolved = resolveEffective(item, defaultCacheMethod)
  const { stats, unmatched } = await getWorkItemCacheStats(item, environment)
  const ownKey = getStateKey(stats, concreteMethod(resolved, defaultCacheMethod))

  const depKeys: string[] = []
  let provable = isOwnProvable(item, unmatched)
  for (const dep of item.deps) {
    const effective = await resolveEffectiveStateKey(dep, defaultCacheMethod, environment, memo, path)
    depKeys.push(effective.stateKey)
    provable = provable && effective.provable
  }
  // what a task that needs a service passed against: the sources of the service and of the
  // tasks it depends on (its definition is in the task id, getWorkServiceCacheIdentity)
  for (const need of item.needs) {
    const effective = await resolveNeedStateKey(need.service, defaultCacheMethod, environment, memo, path)
    depKeys.push(`${need.name}=${effective.stateKey}`)
  }

  return { stateKey: combineStateKeys(ownKey, depKeys), stats, resolved, provable, unmatched }
}

// A needed service's sources folded with the state keys of its dependencies and needs. It
// does not make the task that needs it unprovable: a dependency without `src` (resetting the
// service's data, say) is skipped with the service when the task is a cache hit.
function resolveNeedStateKey(
  service: WorkItemState<WorkService, any>,
  defaultCacheMethod: CacheMethod,
  environment: Environment,
  memo: StateKeyMemo,
  parentPath: ReadonlySet<string>
): Promise<EffectiveStateKey> {
  const memoKey = `need\0${service.name}`
  if (parentPath.has(memoKey)) {
    return Promise.resolve(LOOP)
  }
  const path = new Set(parentPath).add(memoKey)
  return memoized(memo, memoKey, async () => {
    const resolved = resolveEffective(service, defaultCacheMethod)
    const { stats } = await getWorkItemCacheStats(service, environment)
    const keys: string[] = []
    for (const dep of service.deps) {
      keys.push((await resolveEffectiveStateKey(dep, defaultCacheMethod, environment, memo, path)).stateKey)
    }
    for (const need of service.needs) {
      const effective = await resolveNeedStateKey(need.service, defaultCacheMethod, environment, memo, path)
      keys.push(`${need.name}=${effective.stateKey}`)
    }
    return {
      stateKey: combineStateKeys(getStateKey(stats, concreteMethod(resolved, defaultCacheMethod)), keys),
      provable: true,
    }
  })
}
