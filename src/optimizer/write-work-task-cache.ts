import { getWorkCacheStats } from './get-work-cache-stats'
import { Environment } from '../executer/environment'
import { getCacheDescriptionFile, getCacheDirectory, getCacheStatsFile } from './get-cache-directory'
import { getWorkTaskCacheDescription } from './work-task-cache-description'
import { WorkItem } from '../planner/work-item'
import { WorkTask } from '../planner/work-task'

export async function writeWorkTaskCache(task: WorkItem<WorkTask>, context: Environment): Promise<void> {
  const cachePath = getCacheDirectory(task.cacheId())
  const cacheFile = getCacheStatsFile(task.cacheId())
  const cacheDescriptionFile = getCacheDescriptionFile(task.cacheId())
  const cache = await getWorkCacheStats(task.data, context)
  const taskDescription = getWorkTaskCacheDescription(task.data)

  await context.file.createDirectory(cachePath)
  task.status.write('debug', `write cache description for ${task.name} to ${cacheDescriptionFile}`)
  await context.file.writeFile(cacheDescriptionFile, JSON.stringify(taskDescription, null, 2))
  task.status.write('debug', `write file cache for ${task.name} to ${cacheFile}`)
  await context.file.writeFile(cacheFile, JSON.stringify(cache, null, 2))
}
