import { calculateChecksum } from './calculate-checksum'
import { join, relative } from 'path'
import { WorkCacheFileStats } from './work-node-cache-stats'
import { WorkNode } from '../planner/work-node'
import { Environment } from '../executer/environment'
import { WorkService } from '../planner/work-service'
import { CacheMethod } from '../parser/cache-method'
import { createHash } from 'crypto'

async function addWorkCacheStats(
  result: WorkCacheFileStats,
  cwd: string,
  path: string,
  matcher: (file: string) => boolean,
  context: Environment
) {
  const exists = await context.file.exists(path)
  if (!exists) {
    return
  }

  const stats = await context.file.stats(path)
  if (stats.type === 'file') {
    if (matcher(path)) {
      const checksum = await calculateChecksum(context, path)
      result.files[relative(cwd, path)] = { lastModified: stats.lastModified, checksum }
    }
  } else if (stats.type === 'directory') {
    const files = await context.file.listFiles(path)
    for (const file of files) {
      const subPath = join(path, file)
      if (matcher(subPath)) {
        await addWorkCacheStats(result, cwd, join(path, file), matcher, context)
      }
    }
  }
}

export async function getWorkCacheStats(
  work: WorkNode | WorkService,
  environment: Environment
): Promise<WorkCacheFileStats> {
  const result: WorkCacheFileStats = {
    created: new Date(),
    files: {},
  }

  for (const src of work.src) {
    await addWorkCacheStats(result, work.cwd, src.absolutePath, (file) => src.matcher(file, work.cwd), environment)
  }

  return result
}

export function getStateKey(stats: WorkCacheFileStats, cacheMethod: CacheMethod): string {
  const contents = []
  for (const key of Object.keys(stats.files)) {
    if (cacheMethod === 'checksum') {
      contents.push(`${key}:${stats.files[key].checksum}`)
    } else if (cacheMethod === 'modify-date') {
      contents.push(`${key}:${stats.files[key].lastModified}`)
    }
  }
  return createHash('md5').update(contents.join(',')).digest('hex')
}
