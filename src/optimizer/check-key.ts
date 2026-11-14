import { createHash } from 'crypto'
import { Environment } from '../executer/environment'
import { isOwnProvable } from '../executer/scheduler/state-key'
import { WorkItem } from '../planner/work-item'
import { WorkService } from '../planner/work-service'
import { WorkTask } from '../planner/work-task'
import { WorkCacheFileStats } from './work-cache-stats'
import { getWorkCacheStats, getWorkItemCheckoutStats } from './get-work-cache-stats'
import { getWorkTaskCacheDescription } from './work-task-cache-description'

/**
 * What a passed check is recorded under, and what `remote verify` looks it up by: the
 * inputs of the task's cache key, so a cached result counts for the same key it was
 * stored under. Its definition (the services it needs included), the files of its `src`,
 * the keys of its dependencies, and the sources of the services it needs and of the tasks
 * they depend on.
 *
 * It is computed on a checkout before anything ran in it, on both ends, so it also covers
 * the files a commit holds where a dependency generates (the cache leaves those out, as
 * they change once the dependency ran), and it leaves out `.git`, which is no file of a
 * commit. Two checkouts of the same files give the same key wherever they are.
 * Null for a task that can not be proven up to date (no `src` of its own, or none that
 * matches a file, here or in a dependency): its result says nothing about any files.
 */
export async function getCheckKey(
  item: WorkItem<WorkTask>,
  environment: Environment,
  memo: Map<string, Promise<string | null>> = new Map(),
  path: ReadonlySet<string> = new Set()
): Promise<string | null> {
  return memoized(memo, path, `task\0${item.id()}`, (inner) => computeCheckKey(item, environment, memo, inner))
}

async function computeCheckKey(
  item: WorkItem<WorkTask>,
  environment: Environment,
  memo: Map<string, Promise<string | null>>,
  path: ReadonlySet<string>
): Promise<string | null> {
  const { stats, unmatched } = await getWorkItemCheckoutStats(item, environment)
  if (!isOwnProvable(item, unmatched)) {
    return null
  }
  const inputs = await getInputKeys(item, environment, memo, path)
  if (inputs === null) {
    return null
  }
  return hash({ task: getWorkTaskCacheDescription(item), files: commitFiles(stats), ...inputs })
}

// The sources of a needed service, with the keys of what it depends on and needs; its
// definition is in the description of the task that needs it.
function getNeedKey(
  item: WorkItem<WorkService>,
  environment: Environment,
  memo: Map<string, Promise<string | null>>,
  path: ReadonlySet<string>
): Promise<string | null> {
  return memoized(memo, path, `need\0${item.name}`, async (inner) => {
    const inputs = await getInputKeys(item, environment, memo, inner)
    if (inputs === null) {
      return null
    }
    return hash({ files: commitFiles(await getWorkCacheStats(item.data, environment)), ...inputs })
  })
}

async function getInputKeys(
  item: WorkItem<WorkTask | WorkService>,
  environment: Environment,
  memo: Map<string, Promise<string | null>>,
  path: ReadonlySet<string>
): Promise<{ deps: string[]; needs: string[] } | null> {
  const deps: string[] = []
  for (const dep of item.deps) {
    const key = await getCheckKey(dep, environment, memo, path)
    if (key === null) {
      return null
    }
    deps.push(key)
  }
  const needs: string[] = []
  for (const need of item.needs) {
    const key = await getNeedKey(need.service, environment, memo, path)
    if (key === null) {
      return null
    }
    needs.push(`${need.name}=${key}`)
  }
  return { deps: deps.sort(), needs: needs.sort() }
}

// a commit never holds `.git`: what a checkout keeps there differs between a CI job's clone,
// the server's fetch and a sandbox's copy, which has none
function commitFiles(stats: WorkCacheFileStats): string[][] {
  return Object.keys(stats.files)
    .filter((path) => !path.split('/').includes('.git'))
    .sort()
    .map((path) => [path, stats.files[path].checksum])
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

// `path` holds the keys being computed on the way here: one coming back is a loop (services
// that need each other), which can not be proven and fails to plan anyway. Waiting on its
// pending promise would never end. The keys are computed one after another, so every pending
// promise in the memo is on the path.
function memoized(
  memo: Map<string, Promise<string | null>>,
  path: ReadonlySet<string>,
  key: string,
  compute: (path: ReadonlySet<string>) => Promise<string | null>
): Promise<string | null> {
  if (path.has(key)) {
    return Promise.resolve(null)
  }
  const known = memo.get(key)
  if (known) {
    return known
  }
  const computed = compute(new Set([...path, key]))
  memo.set(key, computed)
  return computed
}
