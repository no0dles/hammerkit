import { dirname, join } from 'path'
import { getWorkNodeCacheStats } from './get-work-node-cache-stats'
import { WorkNode } from '../planner/work-node'
import { WorkNodeCacheStats } from './work-node-cache-stats'
import { getWorkDescription } from './work-node-description'
import { Environment } from '../run-arg'

export async function writeWorkNodeCache(node: WorkNode, context: Environment): Promise<void> {
  node.status.console.write('internal', 'debug', `write cache for ${node.name}`)
  const cacheFile = join(node.cwd, '.hammerkit', node.name + '.json')
  const cache = await getWorkNodeCacheStats(node, context)
  const content: WorkNodeCacheStats = {
    task: getWorkDescription(node),
    stats: cache,
  }
  await context.file.createDirectory(dirname(cacheFile))
  await context.file.writeFile(cacheFile, JSON.stringify(content, null, 2))
}
