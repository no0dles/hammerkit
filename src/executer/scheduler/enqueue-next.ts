import { Environment } from '../environment'
import { CacheMethod } from '../../parser/cache-method'
import { isWorkTaskItem, WorkItemState } from '../../planner/work-item'
import { isAggregateTask, WorkTask } from '../../planner/work-task'
import { WorkService } from '../../planner/work-service'
import { ResolvedCache } from '../../cache/resolve-cache'
import { getCacheDirectory } from '../../optimizer/get-cache-directory'
import { writeCacheMetadata } from '../cache-metadata'
import { getWorkTaskCacheDescription } from '../../optimizer/work-task-cache-description'
import { getErrorMessage } from '../../log'
import { computeStateKey, resolveEffective } from './state-key'
import { getWorkInstanceId } from '../../planner/work-instance-id'
import { clearDeferredRestore, deferRestore } from '../deferred-restore'
import { WorkCacheFileStats } from '../../optimizer/work-cache-stats'

export interface CacheState {
  cached: boolean
  stateKey: string
  resolved: ResolvedCache
  // false when the task cannot be proven up to date, see computeStateKey
  provable: boolean
}

// The key a task whose cache is off runs and records its outputs under. It is
// no hash, so a later run with its cache on never takes those outputs as its own.
export const UNCACHED_STATE_KEY = 'uncached'

export async function checkCacheState(
  item: WorkItemState<WorkTask | WorkService, any>,
  defaultCacheMethod: CacheMethod,
  environment: Environment,
  // watch mode compares keys to rerun on a change, so it needs one even when
  // the cache is off
  // restore: false only looks a backend hit up, its outputs are downloaded once
  // something that runs depends on them (`run --no-restore`, see deferred-restore)
  options: { watch?: boolean; restore?: boolean } = {}
): Promise<CacheState> {
  clearDeferredRestore(item)

  // A task whose cache is off is never looked up, so hashing its sources buys
  // nothing, and a `**` over a node_modules takes most of a minute (every run
  // with arguments). Its dependents still hash its sources for their own key.
  const declared = resolveEffective(item, defaultCacheMethod)
  if (declared.method === 'none' && isWorkTaskItem(item) && !options.watch) {
    item.status.write('debug', `${item.name} is skipping cache check, because caching is disabled`)
    return { cached: false, stateKey: UNCACHED_STATE_KEY, resolved: declared, provable: false }
  }

  const {
    stateKey,
    stats: currentStats,
    resolved,
    provable,
    unmatched,
  } = await computeStateKey(item, defaultCacheMethod, environment)

  for (const src of unmatched) {
    item.status.write('warn', `src "${src.source}" matches no files`)
  }

  if (resolved.method === 'none') {
    item.status.write('debug', `${item.name} is skipping cache check, because caching is disabled`)
    return { cached: false, stateKey, resolved, provable }
  }

  if (isWorkTaskItem(item) && !provable) {
    item.status.write('debug', `${item.name} always runs, it or one of its dependencies has no src files`)
    return { cached: false, stateKey, resolved, provable }
  }

  // An aggregate runs nothing, so running it costs nothing, and it is never a hit itself:
  // asked for, it still has its dependencies checked and their outputs restored. Its key
  // counts for what depends on it, and it is reported cached when they all were.
  if (isWorkTaskItem(item) && isAggregateTask(item.data)) {
    return { cached: false, stateKey, resolved, provable }
  }

  if (isWorkTaskItem(item)) {
    const runtimeStateKey = await item.runtime.currentStateKey(environment)

    if (runtimeStateKey === stateKey) {
      return { cached: true, stateKey, resolved, provable }
    }

    if (options.restore === false && options.watch) {
      item.status.write('debug', `${item.name} restores cache hits, --no-restore has no effect in watch mode`)
    }

    if (options.restore === false && !options.watch) {
      try {
        if (await resolved.backend.has(item.id(), stateKey, environment)) {
          item.status.write(
            'info',
            `${item.name} found in cache "${resolved.name}" (${resolved.backend.type}), not restored`
          )
          await touchEntry(item, resolved, stateKey, environment)
          deferRestore(item, async () => {
            if (!(await restoreFromBackend(item, resolved, stateKey, currentStats, environment))) {
              throw new Error(
                `${item.name} is no longer in cache "${resolved.name}", its outputs can not be restored. ` +
                  'Run again without --no-restore.'
              )
            }
          })
          return { cached: true, stateKey, resolved, provable }
        }
      } catch (e) {
        item.status.write(
          'warn',
          `${item.name} failed to look up cache "${resolved.name}": ${getErrorMessage(
            e
          )} — continuing with local execution`
        )
      }
      return { cached: false, stateKey, resolved, provable }
    }

    try {
      if (await restoreFromBackend(item, resolved, stateKey, currentStats, environment)) {
        return { cached: true, stateKey, resolved, provable }
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

  return { cached: false, stateKey, resolved, provable }
}

// Pull a task's entry and restore its outputs into the checkout. False when the
// backend has no such entry.
async function restoreFromBackend(
  item: WorkItemState<WorkTask, any>,
  resolved: ResolvedCache,
  stateKey: string,
  currentStats: WorkCacheFileStats,
  environment: Environment
): Promise<boolean> {
  const cacheDir = getCacheDirectory(getWorkInstanceId(item))
  const pulled = await resolved.backend.pull(item.id(), stateKey, cacheDir, environment)
  if (!pulled) {
    return false
  }
  item.status.write('info', `${item.name} pulled from cache "${resolved.name}" (${resolved.backend.type})`)
  await item.runtime.restore(environment, cacheDir, stateKey)
  await writeCacheMetadata(environment, item, currentStats, getWorkTaskCacheDescription(item))
  return true
}

// A hit that is only looked up still counts as used, so retention keeps it.
// Best effort: the hit stands whether or not the marker could be written.
async function touchEntry(
  item: WorkItemState<WorkTask, any>,
  resolved: ResolvedCache,
  stateKey: string,
  environment: Environment
): Promise<void> {
  try {
    await resolved.backend.touch?.(item.id(), stateKey, environment)
  } catch (e) {
    item.status.write('debug', `${item.name} could not mark its cache entry as used: ${getErrorMessage(e)}`)
  }
}
