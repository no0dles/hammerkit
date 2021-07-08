import { calculateChecksum } from './calculate-checksum'
import { join } from 'path'
import { WorkNodeCacheFileStats } from './work-node-cache-stats'
import { WorkNode } from '../planner/work-node'
import { Context } from '../run-arg'

async function addWorkNodeCacheStats(
  result: WorkNodeCacheFileStats,
  path: string,
  matcher: (file: string) => boolean,
  context: Context
) {
  const stats = await context.file.stats(path)
  if (stats.type === 'file') {
    if (matcher(path)) {
      const checksum = await calculateChecksum(path)
      result[path] = { lastModified: stats.lastModified, checksum }
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

export async function getWorkNodeCacheStats(cache: WorkNode, context: Context): Promise<WorkNodeCacheFileStats> {
  const result: WorkNodeCacheFileStats = {}

  for (const src of cache.src) {
    await addWorkNodeCacheStats(result, src.absolutePath, (file) => src.matcher(file, cache.cwd), context)
  }

  return result
}
