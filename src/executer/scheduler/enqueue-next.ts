import { WorkNode } from '../../planner/work-node'
import { readCache } from '../../optimizer/read-work-node-cache'
import { getWorkNodeCacheStats, hasStatsChanged } from '../../optimizer/get-work-node-cache-stats'
import { Environment } from '../environment'
import { CacheMethod } from '../../optimizer/cache-method'

export async function checkIfUpToDate(
  cacheMethod: CacheMethod,
  node: WorkNode,
  environment: Environment
): Promise<boolean> {
  if (cacheMethod === 'none') {
    return false
  }

  const cache = await readCache(node, environment)
  if (!cache) {
    node.status.write('debug', `${node.name} can't be skipped because there is no cache`)
    return false
  }

  const currentStats = await getWorkNodeCacheStats(node, environment)
  const changed = await hasStatsChanged(node, cache, currentStats, cacheMethod)
  if (changed) {
    return false
  }

  node.status.write('debug', `${node.name} is skipped because it's cache is up to date`)
  return true
}