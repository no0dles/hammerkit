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

export async function checkCacheState(
  item: WorkItemState<WorkTask | WorkService, any>,
  defaultCacheMethod: CacheMethod,
  environment: Environment
): Promise<CacheState> {
  const resolved = resolveEffective(item, defaultCacheMethod)

  const currentStats = await getWorkCacheStats(item.data, environment)
  const stateKey = getStateKey(currentStats, resolved.method)

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
