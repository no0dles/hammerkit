import { WorkTree } from '../planner/work-tree'
import { readCache } from './read-work-node-cache'
import { getWorkDescription } from './work-node-description'
import { getWorkNodeCacheStats } from './get-work-node-cache-stats'
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
    let changed = false
    for (const key of Object.keys(cache.files)) {
      if (
        (context.cacheMethod === 'checksum' && currentStats.files[key]?.checksum !== cache.files[key].checksum) ||
        (context.cacheMethod === 'modify-date' &&
          currentStats.files[key]?.lastModified !== cache.files[key].lastModified)
      ) {
        node.status.console.write(
          'internal',
          'debug',
          context.cacheMethod === 'checksum'
            ? `${key} changed from checksum ${cache.files[key].checksum} to ${currentStats.files[key]?.checksum}`
            : `${key} changed from last modified ${cache.files[key].lastModified} to ${currentStats.files[key]?.lastModified}`
        )
        node.status.console.write('internal', 'debug', `${node.name} can't be skipped because ${key} has been modified`)
        changed = true
        break
      }
    }

    if (changed) {
      continue
    }

    node.status.console.write('internal', 'debug', `${node.name} is skipped because it's cache is up to date`)
    completeNode(workTree, key, context, false)
  }

  return workTree
}
