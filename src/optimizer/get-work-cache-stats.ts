import { calculateChecksum } from './calculate-checksum'
import { join, posix, relative, sep } from 'path'
import { WorkCacheFileStats } from './work-cache-stats'
import { WorkTask } from '../planner/work-task'
import { Environment } from '../executer/environment'
import { WorkService } from '../planner/work-service'
import { CacheMethod } from '../parser/cache-method'
import { createHash } from 'crypto'
import { lstat, readlink } from 'fs/promises'
import { WorkItem } from '../planner/work-item'
import { WorkSource } from '../planner/work-source'
import { createLimit, Limit } from '../utils/limit'

export interface SourceStats {
  stats: WorkCacheFileStats
  // declared (not inherited) src entries that match no file
  unmatched: WorkSource[]
}

function isExcluded(path: string, excluded: string[]): boolean {
  return excluded.some((excludedPath) => path === excludedPath || path.startsWith(excludedPath + sep))
}

// What the walk does at once: a stat, a listing or a checksum of a file each. Awaited one
// after the other, a walk of a thousand files spent most of its time waiting for the disk.
const WALK_CONCURRENCY = 32

type Visited =
  | { type: 'none' }
  | { type: 'file'; key: string; lastModified: number; checksum: string }
  | { type: 'directory'; files: string[] }

async function addWorkCacheStats(
  result: WorkCacheFileStats,
  cwd: string,
  path: string,
  matcher: (file: string, partial?: boolean) => boolean,
  context: Environment,
  root: boolean,
  excluded: string[],
  limit: Limit = createLimit(WALK_CONCURRENCY)
): Promise<number> {
  if (isExcluded(path, excluded)) {
    return 0
  }

  // the slot is held for what this path needs of the disk, not while its children are walked
  const visited = await limit((): Promise<Visited> => visitPath(cwd, path, matcher, context, root))
  if (visited.type === 'file') {
    // '/'-separated on every OS, so a Windows host keys a container task like Linux
    result.files[visited.key] = { lastModified: visited.lastModified, checksum: visited.checksum }
    return 1
  }
  if (visited.type === 'directory') {
    const counts = await Promise.all(
      visited.files.map((file) =>
        addWorkCacheStats(result, cwd, join(path, file), matcher, context, false, excluded, limit)
      )
    )
    return counts.reduce((sum, count) => sum + count, 0)
  }
  return 0
}

async function visitPath(
  cwd: string,
  path: string,
  matcher: (file: string, partial?: boolean) => boolean,
  context: Environment,
  root: boolean
): Promise<Visited> {
  const key = relative(cwd, path).split(sep).join(posix.sep)

  // On a server the files were written by a commit or a task: a link is a source as it is,
  // its target, and never followed. A `**` would walk `x -> /` through the server's disk.
  if (context.hosted) {
    const link = await lstat(path).catch(() => undefined)
    if (link?.isSymbolicLink()) {
      if (!matcher(path)) {
        return { type: 'none' }
      }
      const checksum = createHash('sha256')
        .update(`link:${await readlink(path)}`)
        .digest('hex')
      return { type: 'file', key, lastModified: link.mtimeMs, checksum }
    }
  }

  const exists = await context.file.exists(path)
  if (!exists) {
    return { type: 'none' }
  }

  const stats = await context.file.stats(path)
  if (stats.type === 'file') {
    if (!matcher(path)) {
      return { type: 'none' }
    }
    const checksum = await calculateChecksum(context, path, stats)
    return { type: 'file', key, lastModified: stats.lastModified, checksum }
  } else if (stats.type === 'directory') {
    // A glob such as src/**/*.ts never matches a directory itself, so a
    // directory is walked when files inside it could match.
    if (!root && !matcher(path, true)) {
      return { type: 'none' }
    }
    return { type: 'directory', files: await context.file.listFiles(path) }
  }
  return { type: 'none' }
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
  // one limit for all its srcs, which are walked at once: an inherited src is often a large
  // part of what a task hashes
  const limit = createLimit(WALK_CONCURRENCY)
  const matches = await Promise.all(
    work.src.map((src) => {
      const matcher = (file: string, partial?: boolean) => src.matcher(file, work.cwd, partial)
      return addWorkCacheStats(result, work.cwd, src.absolutePath, matcher, environment, true, excluded, limit)
    })
  )
  const unmatched = work.src.filter(
    (src, index) => matches[index] === 0 && !src.inherited && !isExcluded(src.absolutePath, excluded)
  )

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

// The source stats of a task with what its dependencies generate: on a checkout nothing ran
// in, those are the files a commit holds there, see check-key.ts.
export async function getWorkItemCheckoutStats(
  item: WorkItem<WorkTask>,
  environment: Environment
): Promise<SourceStats> {
  const { stats } = await collectSourceStats(item.data, environment, [])
  return { stats, unmatched: (await getWorkItemCacheStats(item, environment)).unmatched }
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
  return stateKeyDigest(contents.join(','))
}

// A state key is also the value of the `hammerkit.dev/state` label on Kubernetes, which
// takes at most 63 characters: the sha256 in base 36 has 50.
export function stateKeyDigest(content: string): string {
  const hex = createHash('sha256').update(content).digest('hex')
  return BigInt(`0x${hex}`).toString(36).padStart(50, '0')
}
