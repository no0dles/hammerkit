import { getWorkCacheStats } from './get-work-node-cache-stats'
import { Environment } from '../executer/environment'
import { getCacheDescriptionFile, getCacheDirectory, getCacheStatsFile } from './get-cache-directory'
import { getWorkNodeCacheDescription } from './work-node-cache-description'
import { WorkItem } from '../planner/work-item'
import { WorkNode } from '../planner/work-node'

export async function writeWorkNodeCache(node: WorkItem<WorkNode>, context: Environment): Promise<void> {
  const cachePath = getCacheDirectory(node.id())
  const cacheFile = getCacheStatsFile(node.id())
  const cacheDescriptionFile = getCacheDescriptionFile(node.id())
  const cache = await getWorkCacheStats(node.data, context)
  const taskDescription = getWorkNodeCacheDescription(node.data)

  await context.file.createDirectory(cachePath)
  node.status.write('debug', `write cache description for ${node.name} to ${cacheDescriptionFile}`)
  await context.file.writeFile(cacheDescriptionFile, JSON.stringify(taskDescription, null, 2))
  node.status.write('debug', `write file cache for ${node.name} to ${cacheFile}`)
  await context.file.writeFile(cacheFile, JSON.stringify(cache, null, 2))
}
