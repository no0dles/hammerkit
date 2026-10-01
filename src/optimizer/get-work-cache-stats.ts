import { calculateChecksum } from './calculate-checksum'
import { join, posix, relative, sep } from 'path'
import { WorkCacheFileStats } from './work-cache-stats'
import { WorkTask } from '../planner/work-task'
import { Environment } from '../executer/environment'
import { WorkService } from '../planner/work-service'
import { CacheMethod } from '../parser/cache-method'
import { createHash } from 'crypto'
import { WorkItem } from '../planner/work-item'
import { WorkSource } from '../planner/work-source'

export interface SourceStats {
  stats: WorkCacheFileStats
  // declared (not inherited) src entries that match no file
  unmatched: WorkSource[]
}

function isExcluded(path: string, excluded: string[]): boolean {
  return excluded.some((excludedPath) => path === excludedPath || path.startsWith(excludedPath + sep))
}

async function addWorkCacheStats(
  result: WorkCacheFileStats,
  cwd: string,
  path: string,
  matcher: (file: string, partial?: boolean) => boolean,
  context: Environment,
  root: boolean,
  excluded: string[]
): Promise<number> {
  if (isExcluded(path, excluded)) {
    return 0
  }

  const exists = await context.file.exists(path)
  if (!exists) {
    return 0
  }

  const stats = await context.file.stats(path)
  if (stats.type === 'file') {
    if (!matcher(path)) {
      return 0
    }
    const checksum = await calculateChecksum(context, path)
    // '/'-separated on every OS, so a Windows host keys a container task like Linux
    result.files[relative(cwd, path).split(sep).join(posix.sep)] = { lastModified: stats.lastModified, checksum }
    return 1
  } else if (stats.type === 'directory') {
    // A glob such as src/**/*.ts never matches a directory itself, so a
    // directory is walked when files inside it could match.
    if (!root && !matcher(path, true)) {
      return 0
    }
    let matched = 0
    for (const file of await context.file.listFiles(path)) {
      matched += await addWorkCacheStats(result, cwd, join(path, file), matcher, context, false, excluded)
    }
    return matched
  }
  return 0
}

export async function getWorkCacheStats(
  work: WorkTask | WorkService,
  environment: Environment
): Promise<WorkCacheFileStats> {
  return (await collectSourceStats(work, environment, [])).stats
}

// `excluded` paths are left out of the walk, see getWorkItemCacheStats. A src
// entry inside an excluded path is represented there, so it is never unmatched.
async function collectSourceStats(
  work: WorkTask | WorkService,
  environment: Environment,
  excluded: string[]
): Promise<SourceStats> {
  const result: WorkCacheFileStats = {
    created: new Date(),
    files: {},
  }
  const unmatched: WorkSource[] = []

  for (const src of work.src) {
    const matcher = (file: string, partial?: boolean) => src.matcher(file, work.cwd, partial)
    const matched = await addWorkCacheStats(result, work.cwd, src.absolutePath, matcher, environment, true, excluded)
    if (matched === 0 && !src.inherited && !isExcluded(src.absolutePath, excluded)) {
      unmatched.push(src)
    }
  }

  return { stats: result, unmatched }
}

// The source stats of a task or service, leaving out everything its (transitive)
// dependencies generate. Those outputs are already represented by the
// dependencies' task ids and state keys — and hashing them would key the item
// differently before and after its dependencies ran, since the key is computed
// before they do.
export function getWorkItemCacheStats(
  item: WorkItem<WorkTask | WorkService>,
  environment: Environment
): Promise<SourceStats> {
  return collectSourceStats(item.data, environment, dependencyOutputs(item))
}

function dependencyOutputs(item: WorkItem<WorkTask | WorkService>): string[] {
  const outputs = new Set<string>()
  const visited = new Set<WorkItem<WorkTask>>()
  const visit = (dep: WorkItem<WorkTask>) => {
    if (visited.has(dep)) {
      return
    }
    visited.add(dep)
    for (const generate of dep.data.generates) {
      outputs.add(generate.path)
    }
    dep.deps.forEach(visit)
  }
  item.deps.forEach(visit)
  return [...outputs]
}

export function getStateKey(stats: WorkCacheFileStats, cacheMethod: CacheMethod): string {
  const contents = []
  // Sorted: the walk follows the filesystem's listing order, which differs
  // between machines (ext4 and overlayfs list in hash order).
  for (const key of Object.keys(stats.files).sort()) {
    if (cacheMethod === 'checksum') {
      contents.push(`${key}:${stats.files[key].checksum}`)
    } else if (cacheMethod === 'modify-date') {
      contents.push(`${key}:${stats.files[key].lastModified}`)
    }
  }
  return createHash('md5').update(contents.join(',')).digest('hex')
}
