import colors from 'colors'
import { WorkTree } from '../planner/work-tree'
import { iterateWorkTasks } from '../planner/utils/plan-work-tasks'
import { TaskState } from './scheduler/task-state'
import { Environment } from './environment'
import { printTitle } from '../log'

export type TaskSummaryStatus = 'executed' | 'cached' | 'failed' | 'cancelled'

export interface TaskSummary {
  taskId: string
  taskName: string
  status: TaskSummaryStatus
  // Wall-clock duration in ms; 0 for a task that did not complete (cached tasks
  // complete near-instantly).
  duration: number
  // Why a rebuilt task missed the cache, sourced from the cache-explain engine
  // during the run — present only when the run was invoked with --explain.
  cause?: string
}

export interface RunSummary {
  tasks: TaskSummary[]
  executed: number
  cached: number
  failed: number
  cancelled: number
  // cached / (executed + cached); 0 when no task ran.
  cacheHitRatio: number
  // Wall-clock duration of the whole run, in ms.
  totalDuration: number
}

function statusOf(state: TaskState): TaskSummaryStatus {
  switch (state.type) {
    case 'completed':
      return state.cached ? 'cached' : 'executed'
    case 'error':
    case 'crash':
      return 'failed'
    default:
      // canceled, or never started (pending/starting/ready/running left over from
      // an aborted run) — all surface as cancelled/skipped.
      return 'cancelled'
  }
}

// Derive the run summary purely from the final task states already on the work
// tree — nothing is re-run. Deterministically ordered by task name.
export function summarizeRun(workTree: WorkTree, totalDuration: number): RunSummary {
  const tasks: TaskSummary[] = []
  for (const task of iterateWorkTasks(workTree)) {
    const state = task.state.current
    const cause = state.type === 'completed' && state.missCauses?.length ? state.missCauses.join(', ') : undefined
    tasks.push({
      taskId: task.id(),
      taskName: task.name,
      status: statusOf(state),
      duration: state.type === 'completed' ? state.duration : 0,
      cause,
    })
  }
  tasks.sort((a, b) => a.taskName.localeCompare(b.taskName))

  const executed = tasks.filter((t) => t.status === 'executed').length
  const cached = tasks.filter((t) => t.status === 'cached').length
  const failed = tasks.filter((t) => t.status === 'failed').length
  const cancelled = tasks.filter((t) => t.status === 'cancelled').length
  const ran = executed + cached

  return {
    tasks,
    executed,
    cached,
    failed,
    cancelled,
    cacheHitRatio: ran === 0 ? 0 : cached / ran,
    totalDuration,
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`
  }
  return `${(ms / 1000).toFixed(1)}s`
}

function colorStatus(status: TaskSummaryStatus): string {
  const label = status.padEnd(9)
  switch (status) {
    case 'executed':
      return colors.cyan(label)
    case 'cached':
      return colors.green(label)
    case 'failed':
      return colors.red(label)
    case 'cancelled':
      return colors.grey(label)
  }
}

// Bound the name column so a single very long task name cannot blow out the
// width on large graphs.
const MAX_NAME_WIDTH = 60

export function printRunSummary(environment: Environment, summary: RunSummary): void {
  printTitle(environment, 'Summary')
  if (summary.tasks.length === 0) {
    environment.stdout.write('  nothing ran\n')
    return
  }

  const nameWidth = Math.min(
    MAX_NAME_WIDTH,
    summary.tasks.reduce((max, t) => Math.max(max, t.taskName.length), 0)
  )
  for (const task of summary.tasks) {
    const name =
      task.taskName.length > nameWidth ? `${task.taskName.slice(0, nameWidth - 1)}…` : task.taskName.padEnd(nameWidth)
    const cause = task.cause ? `  ${colors.grey(task.cause)}` : ''
    environment.stdout.write(
      `  ${name}  ${colorStatus(task.status)}  ${colors.grey(formatDuration(task.duration))}${cause}\n`
    )
  }

  const ratio = Math.round(summary.cacheHitRatio * 100)
  const failedSuffix = summary.failed > 0 ? `, ${summary.failed} failed` : ''
  const cancelledSuffix = summary.cancelled > 0 ? `, ${summary.cancelled} cancelled` : ''
  environment.stdout.write(
    `  ${summary.executed} executed, ${summary.cached} cached${failedSuffix}${cancelledSuffix} ` +
      `(${ratio}% cache hit), ${formatDuration(summary.totalDuration)} total\n`
  )
}
