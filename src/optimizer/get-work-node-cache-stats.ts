import { calculateChecksum } from './calculate-checksum'
import { join, relative } from 'path'
import { WorkNodeCacheFileStats } from './work-node-cache-stats'
import { WorkNode } from '../planner/work-node'
import { Environment } from '../executer/environment'
import { CacheMethod } from './cache-method'

async function addWorkNodeCacheStats(
  result: WorkNodeCacheFileStats,
  path: string,
  matcher: (file: string) => boolean,
  context: Environment
) {
  const stats = await context.file.stats(path)
  if (stats.type === 'file') {
    if (matcher(path)) {
      const checksum = await calculateChecksum(context, path)
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

export async function getWorkNodeCacheStats(
  cache: WorkNode,
  environment: Environment
): Promise<WorkNodeCacheFileStats> {
  const result: WorkNodeCacheFileStats = {
    cwd: cache.cwd,
    files: {},
  }

  for (const src of cache.src) {
    await addWorkNodeCacheStats(result, src.absolutePath, (file) => src.matcher(file, cache.cwd), environment)
  }

  return result
}

export async function hasStatsChanged(
  node: WorkNode,
  cache: WorkNodeCacheFileStats,
  current: WorkNodeCacheFileStats,
  cacheMethod: CacheMethod
): Promise<boolean> {
  let changed = false
  for (const key of Object.keys(cache.files)) {
    if (
      (cacheMethod === 'checksum' && current.files[key]?.checksum !== cache.files[key].checksum) ||
      (cacheMethod === 'modify-date' && current.files[key]?.lastModified !== cache.files[key].lastModified)
    ) {
      node.status.console.write(
        'internal',
        'debug',
        cacheMethod === 'checksum'
          ? `${key} changed from checksum ${cache.files[key].checksum} to ${current.files[key]?.checksum}`
          : `${key} changed from last modified ${cache.files[key].lastModified} to ${current.files[key]?.lastModified}`
      )
      node.status.console.write('internal', 'debug', `${node.name} can't be skipped because ${key} has been modified`)
      changed = true
      break
    }
  }
  return changed
}
