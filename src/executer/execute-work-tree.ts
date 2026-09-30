import { WorkTree } from '../planner/work-tree'
import { Environment } from './environment'
import { CliExecOptions } from '../cli'
import { iterateWorkTasks, iterateWorkServices } from '../planner/utils/plan-work-tasks'
import { executeWorkService, stopService } from './execute-work-service'
import { executeWorkTask } from './execute-work-task'
import { WorkItemState } from '../planner/work-item'
import { WorkTask } from '../planner/work-task'
import { TaskState } from './scheduler/task-state'

export async function executeWorkTree(work: WorkTree, environment: Environment, options: CliExecOptions) {
  const itemPromises: Promise<void>[] = []
  const dependents = skippableDependents(work, options)

  for (const task of iterateWorkTasks(work)) {
    if (task.state.current.type === 'pending') {
      itemPromises.push(executeWorkTask(task, environment, options, dependents.get(task.name) ?? null))
    }
  }

  for (const service of iterateWorkServices(work)) {
    if (options.type === 'down') {
      if (service.state.current.type === 'running') {
        itemPromises.push(stopService(service))
      }
    } else if (service.state.current.type === 'pending') {
      itemPromises.push(executeWorkService(service, environment, options))
    }
  }

  await Promise.all(itemPromises)
}

// For every task that may be skipped when nothing needs it, the tasks in this
// run that depend on it. Requested tasks always run; so does anything a service
// depends on, and everything in watch mode or with skipping turned off.
function skippableDependents(
  work: WorkTree,
  options: CliExecOptions
): Map<string, WorkItemState<WorkTask, TaskState>[]> {
  const result = new Map<string, WorkItemState<WorkTask, TaskState>[]>()
  if (options.type !== 'execute' || !options.skipDeps || options.watch || !work.requested) {
    return result
  }

  const neededByService = new Set<string>()
  for (const service of iterateWorkServices(work)) {
    for (const dep of service.deps) {
      neededByService.add(dep.name)
    }
  }

  for (const task of iterateWorkTasks(work)) {
    for (const dep of task.deps) {
      if (work.requested.includes(dep.name) || neededByService.has(dep.name)) {
        continue
      }
      result.set(dep.name, [...(result.get(dep.name) ?? []), task])
    }
  }
  return result
}
