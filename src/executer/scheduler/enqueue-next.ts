import { readCache } from '../../optimizer/read-work-cache'
import { getStateKey, getWorkCacheStats } from '../../optimizer/get-work-cache-stats'
import { Environment } from '../environment'
import { CacheMethod } from '../../parser/cache-method'
import { isWorkTaskItem, WorkItem } from '../../planner/work-item'
import { WorkTask } from '../../planner/work-task'
import { WorkService } from '../../planner/work-service'

export interface CacheState {
  cached: boolean
  stateKey: string
}

export async function checkCacheState(
  item: WorkItem<WorkTask | WorkService>,
  defaultCacheMethod: CacheMethod,
  environment: Environment
): Promise<CacheState> {
  const caching = item.data.caching ?? defaultCacheMethod

  const currentStats = await getWorkCacheStats(item.data, environment)
  const stateKey = getStateKey(currentStats, caching)

  if (caching === 'none') {
    item.status.write('debug', `${item.name} is skipping cache check, because caching is disabled`)
    return { cached: false, stateKey }
  }

  if (isWorkTaskItem(item)) {
    const cache = await readCache(item, environment)
    if (cache === null) {
      item.status.write('debug', `no cache found for ${item.cacheId()}`)
      return { cached: false, stateKey }
    }

    const cacheKey = getStateKey(cache, caching)
    if (cacheKey === stateKey) {
      return {
        cached: true,
        stateKey,
      }
    }
  }

  return {
    cached: false,
    stateKey,
  }
}
