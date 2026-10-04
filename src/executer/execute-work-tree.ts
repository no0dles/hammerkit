import { WorkTree } from '../planner/work-tree'
import { Environment } from './environment'
import { CliExecOptions } from '../cli'
import { iterateWorkTasks, iterateWorkServices } from '../planner/utils/plan-work-tasks'
import { executeWorkService, stopService } from './execute-work-service'
import { executeWorkTask } from './execute-work-task'
import { executeInitTask, findInitOf } from './execute-init-task'
import { Dependent } from './await-completed-dependencies'

export async function executeWorkTree(work: WorkTree, environment: Environment, options: CliExecOptions) {
  const itemPromises: Promise<void>[] = []
  const dependents = skippableDependents(work, options)

  mirrorServicesToInitViews(work)

  for (const task of iterateWorkTasks(work)) {
    if (task.state.current.type !== 'pending') {
      continue
    }
    const initOf = findInitOf(task)
    if (initOf) {
      const service = work.services[initOf.serviceName] ?? null
      // asked for alone (by name), it runs against a service already running too
      const requested = work.requested?.length === 1 && work.requested[0] === task.name
      itemPromises.push(executeInitTask(task, initOf.init, service, requested, environment, options))
      continue
    }
    itemPromises.push(executeWorkTask(task, environment, options, dependents.get(task.name) ?? null))
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

// An init task sees its service through a view that follows the service, so a
// service left running by an earlier `up` is running for its init task too. The
// view runs early only while the init itself runs, see executeWorkService.
function mirrorServicesToInitViews(work: WorkTree) {
  for (const service of iterateWorkServices(work)) {
    if (service.data.type !== 'container-service' || !service.data.init) {
      continue
    }
    const view = service.data.init.state
    view.set(service.state.current)
    service.state.on('init-view', (state) => {
      view.set(state)
    })
  }
}

// For every task that may be skipped when nothing needs it, the tasks and
// services in this run that depend on it. Requested tasks always run; a
// service's dependency runs once the service starts. Everything runs in watch
// mode, under `up` and with skipping turned off.
function skippableDependents(work: WorkTree, options: CliExecOptions): Map<string, Dependent[]> {
  const result = new Map<string, Dependent[]>()
  if (options.type !== 'execute' || !options.skipDeps || options.watch || !work.requested) {
    return result
  }

  // a dependency of nothing in the run (its service needs no one here) has no
  // dependents left, and is skipped
  for (const task of iterateWorkTasks(work)) {
    if (!work.requested.includes(task.name) && !findInitOf(task)) {
      result.set(task.name, [])
    }
  }
  const items: Dependent[] = [...iterateWorkTasks(work), ...iterateWorkServices(work)]
  for (const item of items) {
    for (const dep of item.deps) {
      if (work.requested.includes(dep.name)) {
        continue
      }
      result.set(dep.name, [...(result.get(dep.name) ?? []), item])
    }
  }
  return result
}
