import { WorkTask } from './work-task'
import { WorkItemValidation } from './work-item-validation'
import { Environment } from '../executer/environment'
import { WorkTree } from './work-tree'
import { KubernetesWorkService, WorkService } from './work-service'
import { read } from '../parser/read-build-file'
import { iterateWorkTasks, iterateWorkServices } from './utils/plan-work-tasks'
import { WorkItem } from './work-item'

export async function* validate(workTree: WorkTree, context: Environment): AsyncGenerator<WorkItemValidation> {
  const cycleItems: WorkItem<WorkTask | WorkService>[] = []

  for (const item of iterateWorkServices(workTree)) {
    const service = item.data
    if (!service.description) {
      yield { type: 'warn', message: `missing description`, item: service }
    }
    if (service.type === 'container-service') {
      if (!service.healthcheck) {
        yield { type: 'warn', message: 'missing healthcheck', item: service }
      }

      for (const mount of service.mounts) {
        if (!(await context.file.exists(mount.localPath))) {
          yield {
            type: 'warn',
            message: `mount ${mount.localPath} does not exist`,
            item: service,
          }
        }
      }
    } else {
      if (!(await context.file.exists(service.kubeconfig))) {
        yield {
          type: 'warn',
          message: `kubeconfig ${service.kubeconfig} does not exist`,
          item: service,
        }
      } else if (!(await checkIfContextExists(service, context))) {
        yield {
          type: 'warn',
          message: `context ${service.context} does not exist in kubeconfig ${service.kubeconfig}`,
          item: service,
        }
      }
    }
  }

  for (const item of iterateWorkTasks(workTree)) {
    const task = item.data
    if (!task.description) {
      yield { type: 'warn', message: `missing description`, item: task }
    }

    if ((!task.cmds || task.cmds.length === 0) && (!item.deps || item.deps.length === 0)) {
      yield { type: 'warn', message: `task is empty`, item: task }
    }

    for (const src of task.src) {
      if (!(await context.file.exists(src.absolutePath))) {
        yield {
          type: 'warn',
          message: `src ${src.absolutePath} does not exist`,
          item: task,
        }
      }
    }

    if (cycleItems.indexOf(item) === -1) {
      const cyclePath = hasDependencyCycle(item, [])
      if (cyclePath) {
        cycleItems.push(...cyclePath)
        yield { type: 'error', message: `task cycle detected ${cyclePath.map((n) => n.name).join(' -> ')}`, item: task }
      }
    }
  }
  // TODO check for deps of needs and needs of deps
}

export function hasNeedCycle(
  item: WorkItem<WorkTask | WorkService>,
  currentPath: WorkItem<WorkTask | WorkService>[]
): WorkItem<any>[] | null {
  if (currentPath.indexOf(item) >= 0) {
    return [...currentPath, item]
  }

  for (const dep of item.needs) {
    const depHasCycle = hasNeedCycle(dep.service, [...currentPath, item])
    if (depHasCycle) {
      return depHasCycle
    }
  }

  return null
}

export function hasDependencyCycle(
  item: WorkItem<WorkTask | WorkService>,
  currentPath: WorkItem<WorkTask | WorkService>[]
): WorkItem<WorkTask | WorkService>[] | null {
  if (currentPath.indexOf(item) >= 0) {
    return [...currentPath, item]
  }

  for (const dep of item.deps) {
    const depHasCycle = hasDependencyCycle(dep, [...currentPath, item])
    if (depHasCycle) {
      return depHasCycle
    }
  }

  return null
}

export async function checkIfContextExists(service: KubernetesWorkService, context: Environment): Promise<boolean> {
  const kubeconfig = await read(service.kubeconfig, context)
  if (kubeconfig.contexts && kubeconfig.contexts instanceof Array) {
    return kubeconfig.contexts.some((c: any) => c['name'] === service.context)
  }
  return false
}
