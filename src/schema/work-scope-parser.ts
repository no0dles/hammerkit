import { ReferencedContext } from './reference-parser'
import { isContextTaskFilter, WorkScope } from '../executer/work-scope'
import { WorkTree } from '../planner/work-tree'
import { appliesToLabels } from '../executer/label-values'
import { appendWorkService } from '../planner/utils/append-work-service'
import { appendWorkTask } from '../planner/utils/append-work-task'
import { Environment } from '../executer/environment'
import { WorkService } from '../planner/work-service'
import { WorkTask } from '../planner/work-task'
import { WorkItem, WorkItemState } from '../planner/work-item'
import { appendWorkEnvironment } from '../planner/utils/append-work-environment'
import { TaskState } from '../executer/scheduler/task-state'
import { ServiceState } from '../executer/scheduler/service-state'

export function getWorkContext(context: ReferencedContext, scope: WorkScope, environment: Environment): WorkTree {
  const workTree: WorkTree = { services: {}, environments: {}, tasks: {} }
  const filteredWorkTree: WorkTree = { services: {}, environments: {}, tasks: {} }

  for (const task of Object.values(context.tasks)) {
    const item = appendWorkTask(workTree, task.cwd, task, environment)
    if (matchesTaskWorkScope(item, scope)) {
      applyTask(filteredWorkTree, item)
    }
  }

  for (const service of Object.values(context.services)) {
    const item = appendWorkService(workTree, service, environment)
    if (matchesServiceWorkScope(item.data, scope)) {
      applyService(filteredWorkTree, item)
    }
  }

  for (const env of Object.values(context.environments)) {
    appendWorkEnvironment(filteredWorkTree, env)
  }

  return filteredWorkTree
}

function applyTask(workTree: WorkTree, item: WorkItemState<WorkTask, TaskState>) {
  if (workTree.tasks[item.name]) {
    return
  }
  workTree.tasks[item.name] = item
  applyNeedsAndDeps(workTree, item)
}
function applyService(workTree: WorkTree, item: WorkItemState<WorkService, ServiceState>) {
  if (workTree.services[item.name]) {
    return
  }
  workTree.services[item.name] = item
  applyNeedsAndDeps(workTree, item)
}

function applyNeedsAndDeps(workTree: WorkTree, item: WorkItem<WorkTask | WorkService>) {
  for (const dep of item.deps) {
    applyTask(workTree, dep)
  }
  for (const need of item.needs) {
    applyService(workTree, need.service)
  }
}

function matchesTaskWorkScope(task: WorkItem<WorkTask>, scope: WorkScope): boolean {
  if (isContextTaskFilter(scope)) {
    return task.name === scope.taskName
  }

  return appliesToLabels(task.data.labels, scope)
}

function matchesServiceWorkScope(service: WorkService, scope: WorkScope): boolean {
  if (isContextTaskFilter(scope)) {
    return false
  }

  return appliesToLabels(service.labels, scope)
}
