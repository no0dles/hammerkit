import { Environment } from './environment'
import { WorkItemState } from '../planner/work-item'
import { WorkTask } from '../planner/work-task'
import { TaskState } from './scheduler/task-state'
import { getCacheDirectory } from '../optimizer/get-cache-directory'
import { getWorkInstanceId } from '../planner/work-instance-id'
import { getWorkCacheStats } from '../optimizer/get-work-cache-stats'
import { writeCacheMetadata } from './cache-metadata'
import { getWorkTaskCacheDescription } from '../optimizer/work-task-cache-description'

// Package a task's current outputs as a cache entry (metadata + output
// archives) in its staging directory, and return that directory for a backend
// to push from. Used after a task ran, and by `cache push` for a task whose
// outputs are up to date in this checkout but were never stored in a backend.
export async function archiveTaskEntry(
  work: WorkItemState<WorkTask, TaskState>,
  environment: Environment
): Promise<string> {
  const cacheDir = getCacheDirectory(getWorkInstanceId(work))
  const stats = await getWorkCacheStats(work.data, environment)
  await writeCacheMetadata(environment, work, stats, getWorkTaskCacheDescription(work.data))
  await work.runtime.archive(environment, cacheDir)
  return cacheDir
}
