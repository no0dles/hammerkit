import { WorkNode } from '../../planner/work-node'
import { readCache } from '../../optimizer/read-work-node-cache'
import { getWorkNodeCacheStats, hasStatsChanged } from '../../optimizer/get-work-node-cache-stats'
import { Environment } from '../environment'
import { CacheMethod } from '../../parser/cache-method'

export async function checkIfUpToDate(
  node: WorkNode,
  defaultCacheMethod: CacheMethod,
  environment: Environment
): Promise<boolean> {
  const status = environment.status.task(node)

  if (node.caching === 'none') {
    return false
  }

  const cache = await readCache(node, environment)
  if (!cache) {
    status.write('debug', `${node.name} can't be skipped because there is no cache`)
    return false
  }

  const currentStats = await getWorkNodeCacheStats(node, environment)
  const changed = await hasStatsChanged(
    status,
    { name: node.name, caching: node.caching ?? defaultCacheMethod },
    cache,
    currentStats
  )
  if (changed) {
    return false
  }

  status.write('debug', `${node.name} is skipped because it's cache is up to date`)
  return true
}
