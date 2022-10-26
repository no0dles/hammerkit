import { getWorkNodeCacheStats } from './get-work-node-cache-stats'
import { WorkNode } from '../planner/work-node'
import { Environment } from '../executer/environment'
import { getCacheDescriptionFile, getCacheDirectory, getCacheStatsFile } from './get-cache-directory'
import { getWorkNodeCacheDescription } from './work-node-cache-description'

export async function writeWorkNodeCache(node: WorkNode, context: Environment): Promise<void> {
  const status = context.status.task(node)
  const cachePath = getCacheDirectory(node.id)
  const cacheFile = getCacheStatsFile(node.id)
  const cacheDescriptionFile = getCacheDescriptionFile(node.id)
  const cache = await getWorkNodeCacheStats(node, context)
  const taskDescription = getWorkNodeCacheDescription(node.plannedTask)

  await context.file.createDirectory(cachePath)
  status.write('debug', `write cache description for ${node.name} to ${cacheDescriptionFile}`)
  await context.file.writeFile(cacheDescriptionFile, JSON.stringify(taskDescription, null, 2))
  status.write('debug', `write file cache for ${node.name} to ${cacheFile}`)
  await context.file.writeFile(cacheFile, JSON.stringify(cache, null, 2))
}
