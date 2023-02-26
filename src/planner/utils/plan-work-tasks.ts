import { WorkItemState } from '../work-item'
import { WorkTask } from '../work-task'
import { WorkService } from '../work-service'
import { WorkTree } from '../work-tree'
import { ServiceState } from '../../executer/scheduler/service-state'
import { TaskState } from '../../executer/scheduler/task-state'

export function* iterateWorkServices(workTree: WorkTree): Generator<WorkItemState<WorkService, ServiceState>> {
  for (const service of Object.values(workTree.services)) {
    yield service
  }
}

export function* iterateWorkTasks(workTree: WorkTree): Generator<WorkItemState<WorkTask, TaskState>> {
  for (const task of Object.values(workTree.tasks)) {
    yield task
  }
}

export function hasErrorTask(workTree: WorkTree): boolean {
  for (const task of iterateWorkTasks(workTree)) {
    if (task.state.current.type === 'error') {
      return true
    }
  }
  return false
}

export function hasErrorService(workTree: WorkTree): boolean {
  for (const task of iterateWorkServices(workTree)) {
    if (task.state.current.type === 'error') {
      return true
    }
  }
  return false
}

export function hasError(workTree: WorkTree): boolean {
  if (hasErrorService(workTree)) {
    return true
  }
  if (hasErrorTask(workTree)) {
    return true
  }
  return false
}
