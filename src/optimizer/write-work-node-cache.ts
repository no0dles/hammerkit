import consola from 'consola'
import { dirname, join } from 'path'
import { mkdirSync, writeFileSync } from 'fs'
import { getWorkNodeCacheStats } from './get-work-node-cache-stats'
import { WorkNode } from '../planner/work-node'
import { WorkNodeCacheStats } from './work-node-cache-stats'
import { getWorkDescription } from './work-node-description'

export async function writeWorkNodeCache(node: WorkNode): Promise<void> {
  consola.debug(`write cache for ${node.name}`)
  const cacheFile = join(node.path, '.hammerkit', node.name + '.json')
  const cache = await getWorkNodeCacheStats(node)
  const content: WorkNodeCacheStats = {
    task: getWorkDescription(node),
    stats: cache,
  }
  mkdirSync(dirname(cacheFile), { recursive: true })
  writeFileSync(cacheFile, JSON.stringify(content, null, 2))
}
