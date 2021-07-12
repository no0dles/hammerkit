import { join } from 'path'
import { WorkNode } from '../planner/work-node'
import { WorkNodeCacheStats } from './work-node-cache-stats'
import { Environment } from '../run-arg'

export async function readCache(node: WorkNode, context: Environment): Promise<WorkNodeCacheStats | null> {
  const cacheFile = join(node.cwd, '.hammerkit', node.name + '.json')
  if (!(await context.file.exists(cacheFile))) {
    return null
  }

  try {
    return JSON.parse(await context.file.read(cacheFile))
  } catch (e) {
    node.status.console.write('internal', 'error', `unable to read cache ${cacheFile}`)
  }

  return null
}
