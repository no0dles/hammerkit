import { WorkNode } from '../planner/work-node'
import { Environment } from '../executer/environment'
import { getCacheStatsFile } from './get-cache-directory'
import { WorkNodeCacheFileStats } from './work-node-cache-stats'

export async function readCache(node: WorkNode, context: Environment): Promise<WorkNodeCacheFileStats | null> {
  const cacheFile = getCacheStatsFile(node.id)
  if (!(await context.file.exists(cacheFile))) {
    return null
  }

  try {
    return JSON.parse(await context.file.read(cacheFile))
  } catch (e) {
    context.status.task(node).write('error', `unable to read cache ${cacheFile}`)
  }

  return null
}
