import { ReferencedContext } from './reference-parser'
import { isContextTaskFilter, WorkScope } from '../executer/work-scope'
import { WorkTree } from '../planner/work-tree'
import { appliesToLabels } from '../executer/label-values'
import { appendWorkService, getPlannedService } from '../planner/utils/append-work-service'
import { appendWorkTask } from '../planner/utils/append-work-task'
import { Environment } from '../executer/environment'
import { WorkService } from '../planner/work-service'
import { WorkTask } from '../planner/work-task'
import { WorkItem, WorkItemState } from '../planner/work-item'
import { appendWorkEnvironment } from '../planner/utils/append-work-environment'
import { TaskState } from '../executer/scheduler/task-state'
import { ServiceState } from '../executer/scheduler/service-state'
import { WorkEnvironment } from '../planner/work-environment'

export function defaultEnvironment(context: ReferencedContext): WorkEnvironment {
  if ('default' in context.environments) {
    const defaultEnv = context.environments['default']
    return appendWorkEnvironment(defaultEnv)
  }

  return {
    type: 'docker',
  }
}

export function getWorkContext(context: ReferencedContext, scope: WorkScope, environment: Environment): WorkTree {
  const workTree: WorkTree = {
    services: {},
    environment: defaultEnvironment(context),
    tasks: {},
    caches: context.caches,
  }
  const filteredWorkTree: WorkTree = {
    services: {},
    environment: defaultEnvironment(context),
    tasks: {},
    caches: context.caches,
  }
  const requested: string[] = []
  filteredWorkTree.requested = requested

  for (const [envName, env] of Object.entries(context.environments)) {
    if (envName === scope.environmentName) {
      filteredWorkTree.environment = appendWorkEnvironment(env)
      workTree.environment = filteredWorkTree.environment
    }
  }

  // everything is planned before the run is narrowed: planning a service adds
  // its init task's need on it, which narrowing follows
  const tasks = Object.values(context.tasks).map((task) =>
    appendWorkTask(workTree, task.cwd, task, environment, context)
  )
  const services = Object.values(context.services).map((service) =>
    appendWorkService(workTree, service, environment, context)
  )

  for (const item of tasks) {
    if (matchesTaskWorkScope(item, scope)) {
      requested.push(item.name)
      applyTask(filteredWorkTree, item)
    }
  }

  for (const item of services) {
    if (matchesServiceWorkScope(item.data, scope)) {
      applyService(filteredWorkTree, item)
    }
  }

  keepRequirersInScope(filteredWorkTree)
  return filteredWorkTree
}

// The whole build file is planned first, so a shared service lists every task
// and service that needs it. Those outside this run never start or end, and a
// service waiting for them to finish would keep the run open forever.
function keepRequirersInScope(workTree: WorkTree) {
  const inScope = new Set<WorkItem<WorkTask | WorkService>>([
    ...Object.values(workTree.tasks),
    ...Object.values(workTree.services),
  ])
  for (const service of Object.values(workTree.services)) {
    service.requiredBy = service.requiredBy.filter((required) => inScope.has(required))
    // an init task asked for alone is what its service starts for
    const init = service.data.type === 'container-service' ? service.data.init : null
    if (init && workTree.requested?.length === 1 && workTree.requested[0] === init.task.name) {
      service.requiredBy.push(init.task)
    }
  }
}

function applyTask(workTree: WorkTree, item: WorkItemState<WorkTask, TaskState>) {
  if (workTree.tasks[item.name]) {
    return
  }
  workTree.tasks[item.name] = item
  applyNeedsAndDeps(workTree, item)
}
function applyService(workTree: WorkTree, need: WorkItemState<WorkService, ServiceState>) {
  const item = getPlannedService(need)
  if (workTree.services[item.name]) {
    return
  }
  workTree.services[item.name] = item
  applyNeedsAndDeps(workTree, item)
  // a service in the run brings its init task, which runs once it is healthy
  if (item.data.type === 'container-service' && item.data.init) {
    applyTask(workTree, item.data.init.task)
  }
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
