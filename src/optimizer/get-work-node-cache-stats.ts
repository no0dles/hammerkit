import { calculateChecksum } from './calculate-checksum'
import { join, relative } from 'path'
import { WorkNodeCacheFileStats } from './work-node-cache-stats'
import { WorkNode } from '../planner/work-node'
import { Environment } from '../executer/environment'

async function addWorkNodeCacheStats(
  result: WorkNodeCacheFileStats,
  path: string,
  matcher: (file: string) => boolean,
  context: Environment
) {
  const stats = await context.file.stats(path)
  if (stats.type === 'file') {
    if (matcher(path)) {
      const checksum = await calculateChecksum(path)
      result.files[relative(result.cwd, path)] = { lastModified: stats.lastModified, checksum }
    }
  } else if (stats.type === 'directory') {
    const files = await context.file.listFiles(path)
    for (const file of files) {
      const subPath = join(path, file)
      if (matcher(subPath)) {
        await addWorkNodeCacheStats(result, join(path, file), matcher, context)
      }
    }
  }
}

export async function getWorkNodeCacheStats(cache: WorkNode, context: Environment): Promise<WorkNodeCacheFileStats> {
  const result: WorkNodeCacheFileStats = {
    cwd: cache.cwd,
    files: {},
  }

  for (const src of cache.src) {
    await addWorkNodeCacheStats(result, src.absolutePath, (file) => src.matcher(file, cache.cwd), context)
  }

  return result
}
