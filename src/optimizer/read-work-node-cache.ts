import { Environment } from '../executer/environment'
import { getCacheStatsFile } from './get-cache-directory'
import { WorkCacheFileStats } from './work-node-cache-stats'
import { WorkItem } from '../planner/work-item'
import { WorkNode } from '../planner/work-node'
import { WorkService } from '../planner/work-service'

export async function readCache(node: WorkItem<WorkNode>, context: Environment): Promise<WorkCacheFileStats | null> {
  const cacheFile = getCacheStatsFile(node.id())
  if (!(await context.file.exists(cacheFile))) {
    return null
  }

  try {
    return JSON.parse(await context.file.read(cacheFile))
  } catch (e) {
    node.status.write('error', `unable to read cache ${cacheFile}`)
  }

  return null
}
