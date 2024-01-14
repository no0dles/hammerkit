import { WorkTree } from '../work-tree'
import { WorkRuntime } from '../../runtime/runtime'
import { WorkService } from '../work-service'
import { WorkTask } from '../work-task'
import { dockerServiceRuntime, dockerTaskRuntime } from '../work-runtime-docker'
import { kubernetesForwardRuntime, kubernetesServiceRuntime, kubernetesTaskRuntime } from '../work-runtime-kubernetes'
import { getLocalWorkRuntime } from '../work-runtime-local'
import { TaskState } from '../../executer/scheduler/task-state'
import { ServiceState } from '../../executer/scheduler/service-state'
import {
  isContainerWorkServiceItem,
  isContainerWorkTaskItem,
  isKubernetesWorkServiceItem,
  isLocalWorkTaskItem,
  WorkItem,
} from '../work-item'

export function getWorkServiceRuntime(workTree: WorkTree, service: WorkItem<WorkService>): WorkRuntime<ServiceState> {
  if (isContainerWorkServiceItem(service)) {
    if (workTree.environment.type === 'kubernetes') {
      return kubernetesServiceRuntime(service, workTree.environment)
    } else {
      return dockerServiceRuntime(service, workTree.environment)
    }
  } else if (isKubernetesWorkServiceItem(service)) {
    return kubernetesForwardRuntime(service)
  } else {
    // TODO ensure else case is type safe
    throw new Error(`unknown service runtime`)
  }
}
export function getWorkTaskRuntime(workTree: WorkTree, task: WorkItem<WorkTask>): WorkRuntime<TaskState> {
  if (isLocalWorkTaskItem(task)) {
    return getLocalWorkRuntime(task)
  } else if (isContainerWorkTaskItem(task)) {
    if (workTree.environment.type === 'kubernetes') {
      return kubernetesTaskRuntime(task, workTree.environment)
    } else {
      return dockerTaskRuntime(task, workTree.environment)
    }
  } else {
    // TODO ensure else case is type safe
    throw new Error(`unknown service runtime`)
  }
}
