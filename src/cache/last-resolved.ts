import { createHash } from 'crypto'
import { join } from 'path'
import { findRootEscape } from '../file/within-root'
import { Environment } from '../executer/environment'
import { WorkItem } from '../planner/work-item'
import { WorkTask } from '../planner/work-task'
import { WorkCacheFileStats } from '../optimizer/work-cache-stats'
import { storedCacheDescription, WorkTaskCacheDescription } from '../optimizer/work-task-cache-description'

// A per-task-*name* record of the last run, additive metadata that lets `explain`
// diff the current task against the previous one even when a definition change
// moved the task *id* (the id-keyed cache description would then look "never
// cached"). It MUST NOT influence the hit/miss decision (which stays id + state
// key) — it is written after the decision, purely to explain a later run.
export interface LastResolvedRecord {
  taskId: string
  taskName: string
  description: WorkTaskCacheDescription
  // Source-file stats (per-file checksum + mtime) the run resolved against, so a
  // later explain can name the exact file that changed.
  stats: WorkCacheFileStats
}

// Stored in the project's `.hammerkit` dir (local-first, alongside the local
// runtime state file) keyed by task name. The name is sanitized for the
// filesystem and suffixed with a hash of the full name to avoid collisions
// between names that sanitize to the same string (e.g. referenced `lib:build`).
export function getLastResolvedFile(task: WorkItem<WorkTask>): string {
  const sanitized = task.name.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 80)
  const suffix = createHash('sha1').update(task.name).digest('hex').slice(0, 8)
  return join(task.data.cwd, '.hammerkit', 'last-resolved', `${sanitized}-${suffix}.json`)
}

// The record is written into the project, which a server does not own: a checkout or a
// sandbox whose `.hammerkit` may be a link a contributor committed or a task made, and the
// record would overwrite whatever it points at. A server writes none (`explain` runs where
// the project is), and on a machine a record that would go through a link is left out.
export async function writeLastResolvedRecord(
  environment: Environment,
  task: WorkItem<WorkTask>,
  record: Omit<LastResolvedRecord, 'taskId' | 'taskName'>
): Promise<void> {
  if (environment.hosted) {
    return
  }
  const file = getLastResolvedFile(task)
  if (await findRootEscape(task.data.cwd, file)) {
    return
  }
  await environment.file.createDirectory(join(task.data.cwd, '.hammerkit', 'last-resolved'))
  const payload: LastResolvedRecord = {
    taskId: task.id(),
    taskName: task.name,
    description: storedCacheDescription(record.description),
    stats: record.stats,
  }
  await environment.file.writeFile(file, JSON.stringify(payload))
}

export async function readLastResolvedRecord(
  environment: Environment,
  task: WorkItem<WorkTask>
): Promise<LastResolvedRecord | null> {
  const file = getLastResolvedFile(task)
  if (!(await environment.file.exists(file))) {
    return null
  }
  try {
    const parsed = JSON.parse(await environment.file.read(file)) as LastResolvedRecord
    // A record written by an older hammerkit (or otherwise truncated) lacks the
    // component breakdown explain needs — signal that rather than crashing.
    if (!parsed || typeof parsed !== 'object' || !parsed.description || !parsed.stats) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}
