import { Environment } from '../executer/environment'
import { WorkTree } from '../planner/work-tree'
import { iterateWorkTasks } from '../planner/utils/plan-work-tasks'
import { CacheEntry } from './cache-backend'
import { resolveRemoteBackend } from './cache-sync'
import { planRetention, RetentionPlan, RetentionPolicy } from './retention'
import { DEFAULT_CACHE_NAME, withBuiltinCaches } from './resolve-cache'
import { parseDuration, parseSize } from '../utils/units'

export interface NamedCacheEntry extends CacheEntry {
  // the task's name when it is part of this build file, otherwise null
  taskName: string | null
}

function catalogOf(workTree: WorkTree) {
  return workTree.caches ?? withBuiltinCaches(undefined)
}

function taskNames(workTree: WorkTree): Map<string, string> {
  const names = new Map<string, string>()
  for (const task of iterateWorkTasks(workTree)) {
    names.set(task.id(), task.name)
  }
  return names
}

// List the entries a named cache (default: the machine-local `default` cache)
// holds, labelled with the task names of this build file where they match.
export async function listCache(
  workTree: WorkTree,
  cacheName: string | undefined,
  environment: Environment
): Promise<NamedCacheEntry[]> {
  const name = cacheName ?? DEFAULT_CACHE_NAME
  const backend = resolveRemoteBackend(workTree, name)
  if (!backend.list) {
    throw new Error(`the ${backend.type} backend of cache "${name}" cannot list its entries`)
  }
  const names = taskNames(workTree)
  return (await backend.list(environment)).map((entry) => ({ ...entry, taskName: names.get(entry.taskId) ?? null }))
}

// The retention policy of a cache: its declared `retention` block, with any
// command-line values taking precedence.
export function retentionPolicyOf(
  workTree: WorkTree,
  cacheName: string | undefined,
  overrides: RetentionPolicy
): RetentionPolicy {
  const declared = catalogOf(workTree)[cacheName ?? DEFAULT_CACHE_NAME]?.retention
  return {
    maxAge: overrides.maxAge ?? (declared?.maxAge ? parseDuration(declared.maxAge) : undefined),
    maxSize: overrides.maxSize ?? (declared?.maxSize ? parseSize(declared.maxSize) : undefined),
    keepPerTask: overrides.keepPerTask ?? declared?.keepPerTask,
  }
}

export function hasPolicy(policy: RetentionPolicy): boolean {
  return policy.maxAge !== undefined || policy.maxSize !== undefined || policy.keepPerTask !== undefined
}

export interface PruneResult extends RetentionPlan {
  evict: NamedCacheEntry[]
  keep: NamedCacheEntry[]
}

// Apply a retention policy to a cache. Only ever touches the cache it is given:
// a remote is pruned only when named explicitly (ADR-0001).
export async function pruneCache(
  workTree: WorkTree,
  cacheName: string | undefined,
  policy: RetentionPolicy,
  options: { dryRun: boolean },
  environment: Environment
): Promise<PruneResult> {
  const name = cacheName ?? DEFAULT_CACHE_NAME
  const backend = resolveRemoteBackend(workTree, name)
  const entries = await listCache(workTree, name, environment)
  const plan = planRetention(entries, policy, Date.now()) as PruneResult
  if (!options.dryRun && plan.evict.length > 0) {
    if (!backend.remove) {
      throw new Error(`the ${backend.type} backend of cache "${name}" cannot remove entries`)
    }
    for (const entry of plan.evict) {
      await backend.remove(entry.taskId, entry.stateKey, environment)
    }
  }
  return plan
}

// After a successful run: prune every machine-local cache the run used that
// declares a retention policy. Remote caches are never pruned implicitly.
export async function autoPrune(
  workTree: WorkTree,
  environment: Environment
): Promise<{ cacheName: string; plan: PruneResult }[]> {
  const catalog = catalogOf(workTree)
  const used = new Set<string>()
  for (const task of iterateWorkTasks(workTree)) {
    used.add(task.data.caching.name)
  }
  const results: { cacheName: string; plan: PruneResult }[] = []
  for (const name of used) {
    const spec = catalog[name]
    if (!spec?.retention || spec.backend.type !== 'local') {
      continue
    }
    const policy = retentionPolicyOf(workTree, name, {})
    results.push({ cacheName: name, plan: await pruneCache(workTree, name, policy, { dryRun: false }, environment) })
  }
  return results
}
