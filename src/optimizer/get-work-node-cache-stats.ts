import { calculateChecksum } from './calculate-checksum'
import { join, relative } from 'path'
import { WorkNodeCacheFileStats, WorkServiceCacheFileStats } from './work-node-cache-stats'
import { WorkNode } from '../planner/work-node'
import { Environment } from '../executer/environment'
import { StatusScopedConsole } from '../planner/work-node-status'
import { ContainerWorkService } from '../planner/work-service'
import { CacheMethod } from '../parser/cache-method'
import { createHash } from 'crypto'

async function addWorkNodeCacheStats(
  result: WorkNodeCacheFileStats,
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

async function addWorkServiceCacheStats(result: WorkServiceCacheFileStats, path: string, context: Environment) {
  const exists = await context.file.exists(path)
  if (!exists) {
    return
  }

  const stats = await context.file.stats(path)
  if (stats.type === 'file') {
    const checksum = await calculateChecksum(context, path)
    result.files[path] = { lastModified: stats.lastModified, checksum }
  } else if (stats.type === 'directory') {
    const files = await context.file.listFiles(path)
    for (const file of files) {
      await addWorkServiceCacheStats(result, join(path, file), context)
    }
  }
}

export async function getServiceNodeCacheStats(
  cache: ContainerWorkService,
  environment: Environment
): Promise<WorkServiceCacheFileStats> {
  const result: WorkServiceCacheFileStats = {
    files: {},
  }

  for (const mount of cache.mounts) {
    await addWorkServiceCacheStats(result, mount.localPath, environment)
  }

  return result
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

export interface CacheState {
  changed: boolean
  stateKey: string
}

export async function getCacheState(
  status: StatusScopedConsole,
  node: { name: string; caching: CacheMethod },
  cache: WorkNodeCacheFileStats | WorkServiceCacheFileStats | null,
  current: WorkNodeCacheFileStats | WorkServiceCacheFileStats
): Promise<CacheState> {
  if (cache) {
    let changed = false
    for (const key of Object.keys(cache.files)) {
      if (
        (node.caching === 'checksum' && current.files[key]?.checksum !== cache.files[key].checksum) ||
        (node.caching === 'modify-date' && current.files[key]?.lastModified !== cache.files[key].lastModified)
      ) {
        status.write(
          'debug',
          node.caching === 'checksum'
            ? `${key} changed from checksum ${cache.files[key].checksum} to ${current.files[key]?.checksum}`
            : `${key} changed from last modified ${cache.files[key].lastModified} to ${current.files[key]?.lastModified}`
        )
        status.write('debug', `${node.name} can't be skipped because ${key} has been modified`)
        changed = true
        break
      }
    }

    return {
      changed,
      stateKey: getStateKey(current, node.caching),
    }
  } else {
    return {
      changed: true,
      stateKey: getStateKey(current, node.caching),
    }
  }
}

export function getStateKey(
  stats: WorkNodeCacheFileStats | WorkServiceCacheFileStats,
  cacheMethod: CacheMethod
): string {
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
