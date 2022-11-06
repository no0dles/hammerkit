import { WorkNode } from '../../planner/work-node'
import { readCache } from '../../optimizer/read-work-node-cache'
import { getWorkNodeCacheStats, getStateKey } from '../../optimizer/get-work-node-cache-stats'
import { Environment } from '../environment'
import { CacheMethod } from '../../parser/cache-method'

export async function checkCacheState(
  node: WorkNode,
  defaultCacheMethod: CacheMethod,
  environment: Environment
): Promise<{ cached: boolean; stateKey: string }> {
  const status = environment.status.task(node)
  const caching = node.caching ?? defaultCacheMethod

  const currentStats = await getWorkNodeCacheStats(node, environment)
  const stateKey = getStateKey(currentStats, caching)

  if (caching === 'none') {
    status.write('debug', `${node.name} is skipping cache check, because caching is disabled`)
    return { cached: false, stateKey }
  }

  const cache = await readCache(node, environment)
  if (cache === null) {
    status.write('debug', `${node.name} is skipping cache check, because there was none found`)
    return { cached: false, stateKey }
  }

  const cacheKey = getStateKey(cache, caching)
  return {
    cached: cacheKey === stateKey,
    stateKey,
  }
}
