import { createHash } from 'crypto'
import { Environment } from '../executer/environment'
import { isOwnProvable } from '../executer/scheduler/state-key'
import { WorkItem } from '../planner/work-item'
import { WorkTask } from '../planner/work-task'
import { getWorkItemCacheStats } from './get-work-cache-stats'
import { getWorkTaskCacheDescription } from './work-task-cache-description'

/**
 * What a passed check is recorded under, and what `remote verify` looks it up by: the
 * inputs of the task's cache key (its definition, the files of its `src` and its
 * dependencies' keys), hashed with sha256 throughout. The cache itself hashes with sha1
 * and md5, which is enough to find an entry but not to vouch for one: a file made to
 * share the sha1 of another would pass for it.
 *
 * Like the state key it leaves out what dependencies generate and is computed before
 * anything runs, so two checkouts of the same files give the same key wherever they are;
 * unlike it, it also leaves out `.git`, which is no file of a commit.
 * Null for a task that can not be proven up to date (no `src` of its own, or none that
 * matches a file, here or in a dependency): its result says nothing about any files.
 */
export async function getCheckKey(
  item: WorkItem<WorkTask>,
  environment: Environment,
  memo: Map<string, Promise<string | null>> = new Map()
): Promise<string | null> {
  const known = memo.get(item.id())
  if (known) {
    return known
  }
  const computed = computeCheckKey(item, environment, memo)
  memo.set(item.id(), computed)
  return computed
}

async function computeCheckKey(
  item: WorkItem<WorkTask>,
  environment: Environment,
  memo: Map<string, Promise<string | null>>
): Promise<string | null> {
  const { stats, unmatched } = await getWorkItemCacheStats(item, environment, 'sha256')
  if (!isOwnProvable(item, unmatched)) {
    return null
  }
  const deps: string[] = []
  for (const dep of item.deps) {
    const key = await getCheckKey(dep, environment, memo)
    if (key === null) {
      return null
    }
    deps.push(key)
  }
  // a commit never holds `.git`: what a checkout keeps there differs between a CI job's clone,
  // the server's fetch and a sandbox's copy, which has none
  const files = Object.keys(stats.files)
    .filter((path) => !path.split('/').includes('.git'))
    .sort()
    .map((path) => [path, stats.files[path].checksum])
  return createHash('sha256')
    .update(JSON.stringify({ task: getWorkTaskCacheDescription(item), files, deps: deps.sort() }))
    .digest('hex')
}
