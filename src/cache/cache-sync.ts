import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { Environment } from '../executer/environment'
import { CacheMethod } from '../parser/cache-method'
import { WorkTree } from '../planner/work-tree'
import { iterateWorkTasks } from '../planner/utils/plan-work-tasks'
import { computeStateKey } from '../executer/scheduler/state-key'
import { CacheBackend } from './cache-backend'
import { resolveCache, withBuiltinCaches } from './resolve-cache'
import { archiveTaskEntry } from '../executer/archive-task-entry'

export type CacheSyncDirection = 'pull' | 'push'

export type CacheSyncStatus =
  // the entry was copied to the destination
  | 'transferred'
  // the destination already holds the entry (idempotent no-op)
  | 'present'
  // the source does not hold the entry — best-effort, not an error
  | 'missing'
  // caching is disabled or impossible (no src) for the task, or it already uses the remote itself
  | 'skipped'

export interface CacheSyncResult {
  taskId: string
  taskName: string
  stateKey: string | null
  status: CacheSyncStatus
}

export interface CacheSyncOptions {
  direction: CacheSyncDirection
  // name of the remote entry in the `caches:` block
  remote: string
  cacheDefault: CacheMethod
}

export function resolveRemoteBackend(workTree: WorkTree, remote: string): CacheBackend {
  // resolveCache throws a clear "cache ... is not defined" error for unknown names
  return resolveCache({ name: remote }, workTree.caches ?? withBuiltinCaches(undefined), `--remote ${remote}`).backend
}

// Move cache entries between each in-scope task's own cache and a named remote,
// executing nothing (ADR-0001). The entries moved are those for the tasks'
// *current* state keys, computed by the same engine the scheduler uses, so a
// pull pre-warms exactly what the next build looks up. The work tree already
// contains the transitive dependencies of the selected scope.
//
// Source absence is best-effort ('missing'); any backend error propagates, so
// an explicit pull/push reports an unreachable remote instead of degrading to a
// miss like the inline cache lookup does.
export async function syncCache(
  workTree: WorkTree,
  options: CacheSyncOptions,
  environment: Environment
): Promise<CacheSyncResult[]> {
  const remote = resolveRemoteBackend(workTree, options.remote)
  const results: CacheSyncResult[] = []

  for (const item of iterateWorkTasks(workTree)) {
    const { stateKey, resolved, provable } = await computeStateKey(item, options.cacheDefault, environment)
    const local = resolved.backend
    const result = (status: CacheSyncStatus): CacheSyncResult => ({
      taskId: item.id(),
      taskName: item.name,
      stateKey,
      status,
    })

    if (resolved.method === 'none' || local === remote || !provable) {
      results.push(result('skipped'))
      continue
    }

    const [source, destination] = options.direction === 'pull' ? [remote, local] : [local, remote]
    if (await destination.has(item.id(), stateKey, environment)) {
      results.push(result('present'))
      continue
    }

    // Outputs that are up to date in this checkout but were never stored in a
    // backend (e.g. restored by the runtime's own state) are packaged directly.
    if (options.direction === 'push' && !(await local.has(item.id(), stateKey, environment))) {
      if ((await item.runtime.currentStateKey(environment)) !== stateKey) {
        results.push(result('missing'))
        continue
      }
      await remote.push(item.id(), stateKey, await archiveTaskEntry(item, environment), environment)
      results.push(result('transferred'))
      continue
    }

    // Stage through a private directory: both backends write their completion
    // marker (stats.json) last, so an interrupted transfer is never visible as a
    // complete entry on the destination.
    const staging = join(tmpdir(), `hammerkit-cache-sync-${randomUUID()}`)
    try {
      const pulled = await source.pull(item.id(), stateKey, staging, environment)
      if (!pulled) {
        results.push(result('missing'))
        continue
      }
      await destination.push(item.id(), stateKey, staging, environment)
      results.push(result('transferred'))
    } finally {
      await environment.file.remove(staging)
    }
  }

  return results
}
