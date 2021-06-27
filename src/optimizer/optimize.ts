import { WorkTree } from '../planner/work-tree'
import consola from 'consola'
import { readCache } from './read-work-node-cache'
import { getWorkDescription } from './work-node-description'
import { getWorkNodeCacheStats } from './get-work-node-cache-stats'
import { RunArg } from '../run-arg'

export async function optimize(workTree: WorkTree, arg: RunArg): Promise<WorkTree> {
  if (arg.cacheMethod === 'none') {
    return workTree
  }

  for (const key of Object.keys(workTree.nodes)) {
    const node = workTree.nodes[key]
    if (node.src.length === 0) {
      continue
    }

    const cache = readCache(node)
    if (!cache) {
      consola.debug(`${node.name} can't be skipped because there is no cache`)
      continue
    }

    const current = getWorkDescription(node)
    if (current.image !== cache.task.image) {
      consola.debug(`${node.name} can't be skipped because task image has been modified`)
      continue
    }

    const currentStats = await getWorkNodeCacheStats(node)
    let changed = false
    for (const key of Object.keys(cache.stats)) {
      if (
        (arg.cacheMethod === 'checksum' && currentStats[key]?.checksum !== cache.stats[key].checksum) ||
        (arg.cacheMethod === 'modify-date' && currentStats[key]?.lastModified !== cache.stats[key].lastModified)
      ) {
        consola.debug(`${node.name} can't be skipped because ${key} has been modified`)
        changed = true
        break
      }
    }

    if (changed) {
      continue
    }

    consola.debug(`${node.name} is skipped because it's cache is up to date`)
    node.status.state = { type: 'completed', ended: new Date(), duration: 0 }
    if (!arg.watch) {
      node.status.defer.resolve()
    }
    for (const otherKey of Object.keys(workTree.nodes)) {
      const otherNode = workTree.nodes[otherKey]
      const depNode = otherNode.status.pendingDependencies[node.id]
      if (depNode) {
        delete otherNode.status.pendingDependencies[node.id]
        otherNode.status.completedDependencies[node.id] = depNode
      }
    }
  }

  return workTree
}
