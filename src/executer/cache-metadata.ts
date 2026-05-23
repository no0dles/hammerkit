import { Environment } from './environment'
import { getCacheDescriptionFile, getCacheDirectory, getCacheStatsFile } from '../optimizer/get-cache-directory'
import { WorkCacheFileStats } from '../optimizer/work-cache-stats'
import { WorkTaskCacheDescription } from '../optimizer/work-task-cache-description'

export async function writeCacheMetadata(
  environment: Environment,
  taskId: string,
  stats: WorkCacheFileStats,
  description: WorkTaskCacheDescription
): Promise<void> {
  await environment.file.createDirectory(getCacheDirectory(taskId))
  await environment.file.writeFile(getCacheStatsFile(taskId), JSON.stringify(stats))
  await environment.file.writeFile(getCacheDescriptionFile(taskId), JSON.stringify(description))
}
