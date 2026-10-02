import { Environment } from './environment'
import { getCacheDescriptionFile, getCacheDirectory, getCacheStatsFile } from '../optimizer/get-cache-directory'
import { WorkCacheFileStats } from '../optimizer/work-cache-stats'
import { storedCacheDescription, WorkTaskCacheDescription } from '../optimizer/work-task-cache-description'
import { WorkItem } from '../planner/work-item'
import { WorkTask } from '../planner/work-task'
import { writeLastResolvedRecord } from '../cache/last-resolved'
import { getWorkInstanceId } from '../planner/work-instance-id'

export async function writeCacheMetadata(
  environment: Environment,
  task: WorkItem<WorkTask>,
  stats: WorkCacheFileStats,
  description: WorkTaskCacheDescription
): Promise<void> {
  const taskId = getWorkInstanceId(task)
  await environment.file.createDirectory(getCacheDirectory(taskId))
  await environment.file.writeFile(getCacheStatsFile(taskId), JSON.stringify(stats))
  await environment.file.writeFile(getCacheDescriptionFile(taskId), JSON.stringify(storedCacheDescription(description)))
  // Additive per-task-name record for `explain` — never affects the hit/miss
  // decision, written wherever the id-keyed metadata is.
  await writeLastResolvedRecord(environment, task, { description, stats })
}
