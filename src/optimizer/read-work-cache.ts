import { Environment } from '../executer/environment'
import { getCacheStatsFile } from './get-cache-directory'
import { WorkCacheFileStats } from './work-cache-stats'
import { WorkItem } from '../planner/work-item'
import { WorkTask } from '../planner/work-task'

export async function readCache(task: WorkItem<WorkTask>, context: Environment): Promise<WorkCacheFileStats | null> {
  const cacheFile = getCacheStatsFile(task.cacheId())
  if (!(await context.file.exists(cacheFile))) {
    return null
  }

  try {
    return JSON.parse(await context.file.read(cacheFile))
  } catch (e) {
    task.status.write('error', `unable to read cache ${cacheFile}`)
  }

  return null
}
