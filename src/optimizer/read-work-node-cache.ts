import { join } from 'path'
import { WorkNode } from '../planner/work-node'
import { WorkNodeCacheStats } from './work-node-cache-stats'
import {writeLog} from '../log';
import {Context} from '../run-arg';

export async function readCache(node: WorkNode, context: Context): Promise<WorkNodeCacheStats | null> {
  const cacheFile = join(node.cwd, '.hammerkit', node.name + '.json')
  if (!(await context.file.exists(cacheFile))) {
    return null
  }

  try {
    return JSON.parse(await context.file.read(cacheFile))
  } catch (e) {
    writeLog(node.status.stdout, 'error', `unable to read cache ${cacheFile}`)
  }

  return null
}
