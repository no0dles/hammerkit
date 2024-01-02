import { getStateKey, getWorkCacheStats } from '../../optimizer/get-work-cache-stats'
import { Environment } from '../environment'
import { CacheMethod } from '../../parser/cache-method'
import { isWorkTaskItem, WorkItemState } from '../../planner/work-item'
import { WorkTask } from '../../planner/work-task'
import { WorkService } from '../../planner/work-service'

export interface CacheState {
  cached: boolean
  stateKey: string
}

export async function checkCacheState(
  item: WorkItemState<WorkTask | WorkService, any>,
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
    const runtimeStateKey = await item.runtime.currentStateKey()
    if (stateKey === null) {
      item.status.write('debug', `no cache found for ${item.id()}`)
      return { cached: false, stateKey }
    }

    if (runtimeStateKey === stateKey) {
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
