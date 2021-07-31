import { getWorkNodeCacheStats } from './get-work-node-cache-stats'
import { WorkNode } from '../planner/work-node'
import { getWorkDescription } from './work-node-description'
import { Environment } from '../executer/environment'
import { getCacheDescriptionFile, getCacheStatsDirectory, getCacheStatsFile } from './get-cache-directory'

export async function writeWorkNodeCache(node: WorkNode, context: Environment): Promise<void> {
  const cachePath = getCacheStatsDirectory(node.id, node.cwd)
  const cacheFile = getCacheStatsFile(node.id, node.cwd)
  const cacheDescriptionFile = getCacheDescriptionFile(node.id)
  const cache = await getWorkNodeCacheStats(node, context)
  const taskDescription = getWorkDescription(node.mergedTask, node.mergedDeps)
  await context.file.createDirectory(cachePath)
  node.status.console.write('internal', 'debug', `write cache description for ${node.name} to ${cacheDescriptionFile}`)
  await context.file.writeFile(cacheDescriptionFile, JSON.stringify(taskDescription, null, 2))
  node.status.console.write('internal', 'debug', `write file cache for ${node.name} to ${cacheFile}`)
  await context.file.writeFile(cacheFile, JSON.stringify(cache, null, 2))
}
