import { readCache } from '../../optimizer/read-work-node-cache'
import { getWorkNodeCacheStats, getStateKey } from '../../optimizer/get-work-node-cache-stats'
import { Environment } from '../environment'
import { CacheMethod } from '../../parser/cache-method'
import { WorkItem } from '../../planner/work-item'
import { WorkNode } from '../../planner/work-node'

export async function checkCacheState(
  item: WorkItem<WorkNode>,
  defaultCacheMethod: CacheMethod,
  environment: Environment
): Promise<{ cached: boolean; stateKey: string }> {
  const caching = item.data.caching ?? defaultCacheMethod

  const currentStats = await getWorkNodeCacheStats(item.data, environment)
  const stateKey = getStateKey(currentStats, caching)

  if (caching === 'none') {
    item.status.write('debug', `${item.name} is skipping cache check, because caching is disabled`)
    return { cached: false, stateKey }
  }

  const cache = await readCache(item, environment)
  if (cache === null) {
    item.status.write('debug', `${item.name} is skipping cache check, because there was none found`)
    return { cached: false, stateKey }
  }

  const cacheKey = getStateKey(cache, caching)
  return {
    cached: cacheKey === stateKey,
    stateKey,
  }
}
