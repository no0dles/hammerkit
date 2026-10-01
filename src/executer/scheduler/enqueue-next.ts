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
import { computeStateKey } from './state-key'
import { getWorkInstanceId } from '../../planner/work-instance-id'

export interface CacheState {
  cached: boolean
  stateKey: string
  resolved: ResolvedCache
  // false when the task cannot be proven up to date, see computeStateKey
  provable: boolean
}

export async function checkCacheState(
  item: WorkItemState<WorkTask | WorkService, any>,
  defaultCacheMethod: CacheMethod,
  environment: Environment
): Promise<CacheState> {
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

  if (isWorkTaskItem(item)) {
    const runtimeStateKey = await item.runtime.currentStateKey(environment)

    if (runtimeStateKey === stateKey) {
      return { cached: true, stateKey, resolved, provable }
    }

    try {
      const cacheDir = getCacheDirectory(getWorkInstanceId(item))
      const pulled = await resolved.backend.pull(item.id(), stateKey, cacheDir, environment)
      if (pulled) {
        item.status.write('info', `${item.name} pulled from cache "${resolved.name}" (${resolved.backend.type})`)
        await item.runtime.restore(environment, cacheDir)
        await writeCacheMetadata(environment, item, currentStats, getWorkTaskCacheDescription(item))
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
