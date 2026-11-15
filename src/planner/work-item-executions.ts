import { WorkTask } from './work-task'

// When a command of a task ran, from its start to its exit, as the runtime saw it: the time
// of a task that is not in one of them went to making its container, restoring and storing
// its caches, waiting for a node.
export interface CommandExecution {
  startedAt: Date
  finishedAt: Date
}

// kept by the task, not its item: the runtime and the scheduler hold copies of the item
const executions = new WeakMap<WorkTask, CommandExecution[]>()

export function recordExecution(task: WorkTask, startedAt: Date, finishedAt: Date): void {
  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(finishedAt.getTime()) || finishedAt < startedAt) {
    return
  }
  let list = executions.get(task)
  if (!list) {
    list = []
    executions.set(task, list)
  }
  list.push({ startedAt, finishedAt })
}

// a task that runs again (watch) starts with none
export function clearExecutions(task: WorkTask): void {
  executions.delete(task)
}

export function readExecutions(task: WorkTask): readonly CommandExecution[] {
  return executions.get(task) ?? []
}
