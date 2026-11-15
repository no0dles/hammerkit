import { createHash } from 'crypto'
import { join } from 'path'
import { WorkItem, WorkItemState, isWorkTaskItem } from '../planner/work-item'
import { isAggregateTask, WorkTask } from '../planner/work-task'
import { TaskState } from './scheduler/task-state'
import { WorkService } from '../planner/work-service'
import { WorkTree } from '../planner/work-tree'
import { iterateWorkServices, iterateWorkTasks } from '../planner/utils/plan-work-tasks'
import { Environment } from './environment'
import { getHammerkitDirectory } from '../optimizer/get-cache-directory'
import { getErrorMessage } from '../log'

// What tasks usually take, in ms by task name.
export type TaskDurations = Record<string, number>

type Item = WorkItem<WorkTask | WorkService>

// how many of its last durations a task keeps on this machine, the median of which it is
// expected to take
const KEPT_DURATIONS = 5

/**
 * The priority of a task waiting for a place to run: the time from its start until the end
 * of the longest chain of what waits for it, its own expected duration and that of each
 * task after it. A task on the longest chain of the run starts first, so a long chain does
 * not wait behind short ones that could just as well run later.
 *
 * Expected durations come from past runs. A task without any counts as the median of the
 * others; when none has one, every task counts 1 and the chain is counted in tasks. A task
 * that runs nothing (it only groups others), and one that completed already (it was taken
 * from the cache), count 0. A service counts 0 itself and carries on the chains of the
 * tasks that need it.
 */
export function getTaskPriority(workTree: WorkTree, durations: TaskDurations): (item: Item) => number {
  const items: Item[] = [...iterateWorkTasks(workTree), ...iterateWorkServices(workTree)]
  const dependents = new Map<Item, Item[]>()
  const add = (on: Item, dependent: Item) => {
    const list = dependents.get(on) ?? []
    if (!list.includes(dependent)) {
      list.push(dependent)
    }
    dependents.set(on, list)
  }
  for (const item of items) {
    for (const dep of item.deps) {
      add(dep, item)
    }
    for (const need of item.needs) {
      add(need.service, item)
    }
  }

  const known = items
    .filter((item) => isWorkTaskItem(item) && durations[item.name] !== undefined)
    .map((item) => durations[item.name])
    .sort((a, b) => a - b)
  const fallback = known.length > 0 ? known[Math.floor((known.length - 1) / 2)] : 1

  const cost = (item: Item): number => {
    if (!isWorkTaskItem(item)) {
      return 0
    }
    const state = (item as WorkItemState<WorkTask, TaskState>).state?.current
    if (state?.type === 'completed' || isAggregateTask(item.data)) {
      return 0
    }
    return durations[item.name] ?? fallback
  }

  // a memo holds for one pick: what completed since the last one counts 0 now
  return (item: Item, memo: Map<unknown, number> = new Map()) => {
    const chain = (current: Item, path: Set<Item>): number => {
      const cached = memo.get(current)
      if (cached !== undefined) {
        return cached
      }
      // a loop is refused before a run starts, this only keeps the walk finite
      if (path.has(current)) {
        return 0
      }
      path.add(current)
      let longest = 0
      for (const dependent of dependents.get(current) ?? []) {
        longest = Math.max(longest, chain(dependent, path))
      }
      path.delete(current)
      const value = cost(current) + longest
      memo.set(current, value)
      return value
    }
    return chain(item, new Set())
  }
}

// Where a task keeps its last durations on this machine: below hammerkit's directory, by
// the directory of its build file and its name.
export function getDurationFile(task: WorkItem<WorkTask>): string {
  const key = createHash('sha1').update(`${task.data.cwd}\0${task.name}`).digest('hex')
  return join(getHammerkitDirectory(), 'durations', `${key}.json`)
}

async function readKept(environment: Environment, task: WorkItem<WorkTask>): Promise<number[]> {
  const file = getDurationFile(task)
  try {
    if (!(await environment.file.exists(file))) {
      return []
    }
    const parsed = JSON.parse(await environment.file.read(file))
    return Array.isArray(parsed?.durations)
      ? parsed.durations.filter((value: unknown): value is number => typeof value === 'number' && value >= 0)
      : []
  } catch {
    return []
  }
}

// What the tasks of a run took the last times they ran on this machine.
export async function readTaskDurations(workTree: WorkTree, environment: Environment): Promise<TaskDurations> {
  const durations: TaskDurations = {}
  await Promise.all(
    [...iterateWorkTasks(workTree)].map(async (task) => {
      const kept = await readKept(environment, task)
      if (kept.length > 0) {
        const sorted = [...kept].sort((a, b) => a - b)
        durations[task.name] = sorted[Math.floor((sorted.length - 1) / 2)]
      }
    })
  )
  return durations
}

// Keep what a task took, once it ran to its end. Best effort: a run never fails over it.
export async function recordTaskDuration(
  environment: Environment,
  task: WorkItem<WorkTask>,
  duration: number
): Promise<void> {
  try {
    const kept = [...(await readKept(environment, task)), Math.max(0, Math.round(duration))].slice(-KEPT_DURATIONS)
    await environment.file.createDirectory(join(getHammerkitDirectory(), 'durations'))
    await environment.file.writeFile(getDurationFile(task), JSON.stringify({ durations: kept }))
  } catch (e) {
    task.status.write('debug', `${task.name} could not keep how long it took: ${getErrorMessage(e)}`)
  }
}
