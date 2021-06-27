import { readdirSync, statSync } from 'fs'
import { calculateChecksum } from './calculate-checksum'
import { join } from 'path'
import { WorkNodeCacheFileStats } from './work-node-cache-stats'
import { WorkNode } from '../planner/work-node'

async function addWorkNodeCacheStats(result: WorkNodeCacheFileStats, path: string, matcher: (file: string) => boolean) {
  const stats = statSync(path)
  if (stats.isFile()) {
    if (matcher(path)) {
      const checksum = await calculateChecksum(path)
      result[path] = { lastModified: stats.mtimeMs, checksum }
    }
  } else if (stats.isDirectory()) {
    const files = readdirSync(path)
    for (const file of files) {
      const subPath = join(path, file)
      if (matcher(subPath)) {
        await addWorkNodeCacheStats(result, join(path, file), matcher)
      }
    }
  }
}

export async function getWorkNodeCacheStats(cache: WorkNode): Promise<WorkNodeCacheFileStats> {
  const result: WorkNodeCacheFileStats = {}

  for (const src of cache.src) {
    await addWorkNodeCacheStats(result, src.absolutePath, (file) => src.matcher(file, cache.path))
  }

  return result
}
