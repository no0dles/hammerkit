import { getWorkNodeCacheStats } from './get-work-node-cache-stats'
import { WorkNode } from '../planner/work-node'
import { Environment } from '../executer/environment'
import { getCacheDescriptionFile, getCacheStatsDirectory, getCacheStatsFile } from './get-cache-directory'
import { getWorkNodeCacheDescription } from './work-node-cache-description'
import { CacheMethod } from '../parser/cache-method'

export async function writeWorkNodeCache(
  node: WorkNode,
  defaultCacheMethod: CacheMethod,
  context: Environment
): Promise<void> {
  const status = context.status.task(node)
  const cachePath = getCacheStatsDirectory(node.id, node.cwd)
  const cacheFile = getCacheStatsFile(node.type, node.id, node.cwd)
  const cacheDescriptionFile = getCacheDescriptionFile(node.id)
  const cache = await getWorkNodeCacheStats(node, context)
  const taskDescription = getWorkNodeCacheDescription(node.plannedTask, defaultCacheMethod)
  await context.file.createDirectory(cachePath)
  status.write('debug', `write cache description for ${node.name} to ${cacheDescriptionFile}`)
  await context.file.writeFile(cacheDescriptionFile, JSON.stringify(taskDescription, null, 2))
  status.write('debug', `write file cache for ${node.name} to ${cacheFile}`)
  await context.file.writeFile(cacheFile, JSON.stringify(cache, null, 2))
}
