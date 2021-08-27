import { WorkTree } from '../planner/work-tree'
import { readCache } from './read-work-node-cache'
import { hasStatsChanged, getWorkNodeCacheStats } from './get-work-node-cache-stats'
import { completeNode } from '../executer/states'
import { ExecutionContext } from '../executer/execution-context'

export async function optimize(workTree: WorkTree, context: ExecutionContext): Promise<WorkTree> {
  if (context.cacheMethod === 'none') {
    return workTree
  }

  for (const key of Object.keys(workTree.nodes)) {
    const node = workTree.nodes[key]
    if (node.src.length === 0) {
      continue
    }

    const cache = await readCache(node, context.environment)
    if (!cache) {
      node.status.console.write('internal', 'debug', `${node.name} can't be skipped because there is no cache`)
      continue
    }

    const currentStats = await getWorkNodeCacheStats(node, context.environment)
    const changed = await hasStatsChanged(node, cache, currentStats, context.cacheMethod)
    if (changed) {
      continue
    }

    node.status.console.write('internal', 'debug', `${node.name} is skipped because it's cache is up to date`)
    completeNode(workTree, key, context)
  }

  return workTree
}
