import { WorkTree } from '../planner/work-tree'
import { readCache } from './read-work-node-cache'
import { getWorkDescription } from './work-node-description'
import { getWorkNodeCacheStats } from './get-work-node-cache-stats'
import { ExecutionContext } from '../run-arg'
import { completeNode } from '../executer/states'

export async function optimize(workTree: WorkTree, context: ExecutionContext): Promise<WorkTree> {
  if (context.cacheMethod === 'none') {
    return workTree
  }

  for (const key of Object.keys(workTree.nodes)) {
    const node = workTree.nodes[key]
    if (node.src.length === 0) {
      continue
    }

    const cache = await readCache(node, context.context)
    if (!cache) {
      node.status.console.write('internal', 'debug', `${node.name} can't be skipped because there is no cache`)
      continue
    }

    const current = getWorkDescription(node)
    if (current.image !== cache.task.image) {
      node.status.console.write(
        'internal',
        'debug',
        `${node.name} can't be skipped because task image has been modified`
      )
      continue
    }

    const currentStats = await getWorkNodeCacheStats(node, context.context)
    let changed = false
    for (const key of Object.keys(cache.stats)) {
      if (
        (context.cacheMethod === 'checksum' && currentStats[key]?.checksum !== cache.stats[key].checksum) ||
        (context.cacheMethod === 'modify-date' && currentStats[key]?.lastModified !== cache.stats[key].lastModified)
      ) {
        node.status.console.write(
          'internal',
          'debug',
          context.cacheMethod === 'checksum'
            ? `${key} changed from checksum ${cache.stats[key].checksum} to ${currentStats[key]?.checksum}`
            : `${key} changed from last modified ${cache.stats[key].lastModified} to ${currentStats[key]?.lastModified}`
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
    completeNode(workTree, key, context)
  }

  return workTree
}
