import { WorkNode } from '../../planner/work-node'
import { readCache } from '../../optimizer/read-work-node-cache'
import { getWorkNodeCacheStats, getCacheState, CacheState } from '../../optimizer/get-work-node-cache-stats'
import { Environment } from '../environment'
import { CacheMethod } from '../../parser/cache-method'

export async function checkCacheState(
  node: WorkNode,
  defaultCacheMethod: CacheMethod,
  environment: Environment
): Promise<CacheState> {
  const status = environment.status.task(node)
  const caching = node.caching ?? defaultCacheMethod

  if (caching === 'none') {
    return { changed: true, stateKey: '' }
  }

  const cache = await readCache(node, environment)
  const currentStats = await getWorkNodeCacheStats(node, environment)

  const state = await getCacheState(status, { name: node.name, caching }, cache, currentStats)
  if (!state.changed) {
    status.write('debug', `${node.name} is skipped because it's cache is up to date with ${caching}`)
  }

  return state
}
