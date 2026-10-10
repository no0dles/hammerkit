import colors from 'colors'
import { WorkTree } from '../planner/work-tree'
import { TaskState } from './scheduler/task-state'
import { WorkTask } from '../planner/work-task'
import { WorkItemState } from '../planner/work-item'
import { CacheMethod } from '../parser/cache-method'
import { Environment } from './environment'
import { hasDependencyCycle } from '../planner/validate'
import { describeCause, ExplainCause, ExplainStatus, explainWorkTree } from '../cache/explain'
import { printTitle } from '../log'

export interface DryRunEntry {
  taskId: string
  taskName: string
  status: ExplainStatus
  causes: ExplainCause[]
  // declared resources a local task runs without
  unenforcedResources?: true
}

export interface DryRunPlan {
  entries: DryRunEntry[]
  // Names along a dependency cycle, if any — a cyclic graph is an error under
  // dry-run (there is no valid execution order to preview).
  cycle: string[] | null
}

// Deterministic topological order (dependencies before dependents). Visited-set
// guards against runaway recursion; a real cycle is reported separately.
function topoOrder(workTree: WorkTree): WorkItemState<WorkTask, TaskState>[] {
  const visited = new Set<string>()
  const order: WorkItemState<WorkTask, TaskState>[] = []
  const visit = (task: WorkItemState<WorkTask, TaskState>) => {
    if (visited.has(task.id())) {
      return
    }
    visited.add(task.id())
    for (const dep of [...task.deps].sort((a, b) => a.name.localeCompare(b.name))) {
      visit(dep)
    }
    order.push(task)
  }
  for (const task of Object.values(workTree.tasks).sort((a, b) => a.name.localeCompare(b.name))) {
    visit(task)
  }
  return order
}

// Compute the ordered execution plan with a predicted cache decision per task,
// reusing the cache-explain engine — no command runs, no container/service
// starts, no cache push/pull occurs.
export async function planDryRun(
  workTree: WorkTree,
  defaultCacheMethod: CacheMethod,
  environment: Environment
): Promise<DryRunPlan> {
  for (const task of Object.values(workTree.tasks)) {
    const path = hasDependencyCycle(task, [])
    if (path && path.length > 0) {
      return { entries: [], cycle: path.map((n) => n.name) }
    }
  }

  const explanations = await explainWorkTree(workTree, defaultCacheMethod, environment)
  const byName = new Map(explanations.map((e) => [e.taskName, e]))

  const entries: DryRunEntry[] = []
  for (const task of topoOrder(workTree)) {
    const explanation = byName.get(task.name)
    entries.push({
      taskId: task.id(),
      taskName: task.name,
      status: explanation?.status ?? 'miss',
      causes: explanation?.causes ?? [],
      ...(task.data.type === 'local-task' && task.data.resources ? { unenforcedResources: true as const } : {}),
    })
  }
  return { entries, cycle: null }
}

export function printDryRun(environment: Environment, plan: DryRunPlan): void {
  printTitle(environment, 'Dry run (no commands executed)')
  if (plan.entries.length === 0) {
    environment.stdout.write('  no tasks in scope\n')
    return
  }
  plan.entries.forEach((entry, index) => {
    const label =
      entry.status === 'hit'
        ? colors.green('cache hit')
        : entry.status === 'uncacheable'
          ? colors.grey('uncacheable')
          : colors.yellow('cache miss')
    const causes = entry.causes.length > 0 ? colors.grey(` (${entry.causes.map(describeCause).join(', ')})`) : ''
    const resources = entry.unenforcedResources ? colors.grey(' [resources not enforced for a local task]') : ''
    environment.stdout.write(`  ${index + 1}. ${entry.taskName}: ${label}${causes}${resources}\n`)
  })
}
