import { Environment } from '../executer/environment'
import { CacheMethod } from '../parser/cache-method'
import { WorkItemState } from '../planner/work-item'
import { WorkTask } from '../planner/work-task'
import { WorkTree } from '../planner/work-tree'
import { TaskState } from '../executer/scheduler/task-state'
import { computeStateKey } from '../executer/scheduler/state-key'
import { getWorkTaskCacheDescription, WorkTaskCacheDescription } from '../optimizer/work-task-cache-description'
import { WorkCacheFileStats } from '../optimizer/work-cache-stats'
import { getCacheDescriptionFile } from '../optimizer/get-cache-directory'
import { readLastResolvedRecord } from './last-resolved'
import { getWorkInstanceId } from '../planner/work-instance-id'

export type ExplainStatus = 'hit' | 'miss' | 'uncacheable'

// `no-src`/`caching-disabled` accompany an `uncacheable` status; the rest are
// miss causes (the closed vocabulary from spec FR-002, plus the graceful
// `cache-format-changed` degradation for pre-breakdown entries).
export type ExplainCauseKind =
  | 'no-src'
  | 'caching-disabled'
  | 'never-cached'
  | 'cache-format-changed'
  | 'source-changed'
  | 'source-added'
  | 'source-removed'
  | 'env-changed'
  | 'command-changed'
  | 'image-changed'
  | 'dependency-changed'

export interface ExplainCause {
  kind: ExplainCauseKind
  // The concrete identifier the cause names, where one applies: a source file
  // path, an environment variable name, or a dependency task name.
  identifier?: string
}

export interface TaskExplanation {
  taskId: string
  taskName: string
  status: ExplainStatus
  causes: ExplainCause[]
}

export function describeCause(cause: ExplainCause): string {
  switch (cause.kind) {
    case 'no-src':
      return 'no src declared (uncacheable)'
    case 'caching-disabled':
      return 'caching disabled'
    case 'never-cached':
      return 'never cached'
    case 'cache-format-changed':
      return 'cache format changed'
    case 'source-changed':
      return `source changed: ${cause.identifier}`
    case 'source-added':
      return `source added: ${cause.identifier}`
    case 'source-removed':
      return `source removed: ${cause.identifier}`
    case 'env-changed':
      return `environment variable changed: ${cause.identifier}`
    case 'command-changed':
      return 'command changed'
    case 'image-changed':
      return 'image changed'
    case 'dependency-changed':
      return `dependency changed: ${cause.identifier}`
  }
}

async function safeCurrentStateKey(
  item: WorkItemState<WorkTask, TaskState>,
  environment: Environment
): Promise<string | null> {
  // currentStateKey is read-only (a file read for local, a container *list* for
  // docker/k8s — never a start). If the runtime is unreachable (offline, no
  // daemon) explain must still answer, so failures degrade to "no runtime state".
  try {
    return await item.runtime.currentStateKey(environment)
  } catch {
    return null
  }
}

async function safeHas(
  item: WorkItemState<WorkTask, TaskState>,
  stateKey: string,
  environment: Environment
): Promise<boolean> {
  try {
    return await item.data.caching.backend.has(item.id(), stateKey, environment)
  } catch {
    return false
  }
}

function diffDescription(
  current: WorkTaskCacheDescription,
  previous: WorkTaskCacheDescription,
  causes: ExplainCause[]
): void {
  if (JSON.stringify(current.cmds) !== JSON.stringify(previous.cmds)) {
    causes.push({ kind: 'command-changed' })
  }
  if (current.image !== previous.image) {
    causes.push({ kind: 'image-changed' })
  }
  // shell / mounts / cwd / generates all alter how the task runs; the closed
  // cause vocabulary folds them into "command changed".
  if (
    current.shell !== previous.shell ||
    JSON.stringify(current.mounts) !== JSON.stringify(previous.mounts) ||
    current.cwd !== previous.cwd ||
    JSON.stringify(current.generates) !== JSON.stringify(previous.generates)
  ) {
    if (!causes.some((c) => c.kind === 'command-changed')) {
      causes.push({ kind: 'command-changed' })
    }
  }

  const currentEnvs = current.envs ?? {}
  const previousEnvs = previous.envs ?? {}
  const envKeys = Array.from(new Set([...Object.keys(currentEnvs), ...Object.keys(previousEnvs)])).sort()
  for (const key of envKeys) {
    if (currentEnvs[key] !== previousEnvs[key]) {
      causes.push({ kind: 'env-changed', identifier: key })
    }
  }
}

function diffStats(
  current: WorkCacheFileStats,
  previous: WorkCacheFileStats,
  method: CacheMethod,
  causes: ExplainCause[]
): void {
  const currentFiles = current.files ?? {}
  const previousFiles = previous.files ?? {}
  const paths = Array.from(new Set([...Object.keys(currentFiles), ...Object.keys(previousFiles)])).sort()
  for (const path of paths) {
    const now = currentFiles[path]
    const before = previousFiles[path]
    if (now && !before) {
      causes.push({ kind: 'source-added', identifier: path })
    } else if (!now && before) {
      causes.push({ kind: 'source-removed', identifier: path })
    } else if (now && before) {
      const changed =
        method === 'modify-date' ? now.lastModified !== before.lastModified : now.checksum !== before.checksum
      if (changed) {
        causes.push({ kind: 'source-changed', identifier: path })
      }
    }
  }
}

// Explain a single task, recursively explaining its dependencies so a downstream
// task whose own inputs are unchanged is attributed to the upstream dependency
// that actually changed. Memoized by task id; `visiting` guards against a cyclic
// graph (already rejected by the planner, but explain runs before scheduling).
export async function explainTask(
  item: WorkItemState<WorkTask, TaskState>,
  defaultCacheMethod: CacheMethod,
  environment: Environment,
  memo: Map<string, TaskExplanation> = new Map(),
  visiting: Set<string> = new Set()
): Promise<TaskExplanation> {
  const existing = memo.get(item.id())
  if (existing) {
    return existing
  }
  if (visiting.has(item.id())) {
    // Cycle: report neutrally rather than recursing forever.
    return { taskId: item.id(), taskName: item.name, status: 'miss', causes: [{ kind: 'never-cached' }] }
  }
  visiting.add(item.id())

  const { stateKey, stats, resolved } = await computeStateKey(item, defaultCacheMethod, environment)

  if (item.data.src.length === 0) {
    const explanation: TaskExplanation = {
      taskId: item.id(),
      taskName: item.name,
      status: 'uncacheable',
      causes: [{ kind: 'no-src' }],
    }
    memo.set(item.id(), explanation)
    visiting.delete(item.id())
    return explanation
  }

  if (resolved.method === 'none') {
    const explanation: TaskExplanation = {
      taskId: item.id(),
      taskName: item.name,
      status: 'uncacheable',
      causes: [{ kind: 'caching-disabled' }],
    }
    memo.set(item.id(), explanation)
    visiting.delete(item.id())
    return explanation
  }

  const runtimeStateKey = await safeCurrentStateKey(item, environment)
  const hasEntry = await safeHas(item, stateKey, environment)
  const predictedHit = runtimeStateKey === stateKey || hasEntry

  if (predictedHit) {
    const explanation: TaskExplanation = { taskId: item.id(), taskName: item.name, status: 'hit', causes: [] }
    memo.set(item.id(), explanation)
    visiting.delete(item.id())
    return explanation
  }

  const causes: ExplainCause[] = []
  const record = await readLastResolvedRecord(environment, item)
  if (record === null) {
    const legacyDesc = await environment.file.exists(getCacheDescriptionFile(getWorkInstanceId(item)))
    if (runtimeStateKey === null && !hasEntry && !legacyDesc) {
      causes.push({ kind: 'never-cached' })
    } else {
      // Prior evidence of a run, but no diffable breakdown (pre-feature entry).
      causes.push({ kind: 'cache-format-changed' })
    }
  } else {
    diffDescription(getWorkTaskCacheDescription(item.data), record.description, causes)
    diffStats(stats, record.stats, resolved.method, causes)
  }

  for (const dep of item.deps) {
    const depExplanation = await explainTask(dep, defaultCacheMethod, environment, memo, visiting)
    if (depExplanation.status !== 'hit') {
      causes.push({ kind: 'dependency-changed', identifier: dep.name })
    }
  }

  if (causes.length === 0) {
    // A miss we could not attribute (e.g. the artifact was pruned/evicted though
    // metadata records a prior run) — treat as no usable cache entry.
    causes.push({ kind: 'never-cached' })
  }

  const explanation: TaskExplanation = { taskId: item.id(), taskName: item.name, status: 'miss', causes }
  memo.set(item.id(), explanation)
  visiting.delete(item.id())
  return explanation
}

// Explain every task in scope (the work tree already includes dependencies),
// deterministically ordered by name. Read-only: executes no command, starts no
// container/service, performs no cache push/pull (only metadata `has` lookups).
export async function explainWorkTree(
  workTree: WorkTree,
  defaultCacheMethod: CacheMethod,
  environment: Environment
): Promise<TaskExplanation[]> {
  const memo = new Map<string, TaskExplanation>()
  const tasks = Object.values(workTree.tasks).sort((a, b) => a.name.localeCompare(b.name))
  const results: TaskExplanation[] = []
  for (const task of tasks) {
    results.push(await explainTask(task, defaultCacheMethod, environment, memo))
  }
  return results
}
