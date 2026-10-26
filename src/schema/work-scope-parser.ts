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
import { applyArguments } from '../planner/utils/task-arguments'

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
  // on a server the operator says where things run (a build file there has no environments)
  if (environment.hosted?.kubernetes) {
    workTree.environment = environment.hosted.kubernetes
    filteredWorkTree.environment = environment.hosted.kubernetes
  }

  // everything is planned before the run is narrowed: planning a service adds
  // its init task's need on it, which narrowing follows
  const tasks = Object.values(context.tasks).map((task) =>
    appendWorkTask(workTree, task.cwd, task, environment, context)
  )
  const services = Object.values(context.services).map((service) =>
    appendWorkService(workTree, service, environment, context)
  )

  const apply: ApplyOptions = { servicesAlone: !isContextTaskFilter(scope) && !!scope.names && !!scope.stop }
  const selectedTasks: WorkTask[] = []
  const selectedServices: WorkService[] = []
  for (const item of tasks) {
    if (matchesTaskWorkScope(item, scope)) {
      requested.push(item.name)
      selectedTasks.push(item.data)
      applyTask(filteredWorkTree, item, apply)
    }
  }

  for (const item of services) {
    if (matchesServiceWorkScope(item.data, scope)) {
      selectedServices.push(item.data)
      applyService(filteredWorkTree, item, apply)
    }
  }

  if (!isContextTaskFilter(scope) && scope.names) {
    const known = new Set([...tasks.map((task) => task.name), ...services.map((service) => service.data.name)])
    const unknown = scope.names.filter((name) => !known.has(name))
    if (unknown.length > 0) {
      throw new Error(`no task or service named ${unknown.join(', ')}, see hammerkit ls`)
    }
  }

  if (scope.args) {
    applyArguments(
      { tasks: selectedTasks, services: scope.args.services ? selectedServices : [] },
      scope.args.values,
      scope.args.cache
    )
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

// `down` by name stops what it names and what the named tasks need, and keeps a
// service the named service needs running: others may still use it
interface ApplyOptions {
  servicesAlone: boolean
}

function applyTask(workTree: WorkTree, item: WorkItemState<WorkTask, TaskState>, options: ApplyOptions) {
  if (workTree.tasks[item.name]) {
    return
  }
  workTree.tasks[item.name] = item
  applyNeedsAndDeps(workTree, item, options)
}
function applyService(workTree: WorkTree, need: WorkItemState<WorkService, ServiceState>, options: ApplyOptions) {
  const item = getPlannedService(need)
  if (workTree.services[item.name]) {
    return
  }
  workTree.services[item.name] = item
  if (options.servicesAlone) {
    return
  }
  applyNeedsAndDeps(workTree, item, options)
  // a service in the run brings its init task, which runs once it is healthy
  if (item.data.type === 'container-service' && item.data.init) {
    applyTask(workTree, item.data.init.task, options)
  }
}

function applyNeedsAndDeps(workTree: WorkTree, item: WorkItem<WorkTask | WorkService>, options: ApplyOptions) {
  for (const dep of item.deps) {
    applyTask(workTree, dep, options)
  }
  for (const need of item.needs) {
    applyService(workTree, need.service, options)
  }
}

function matchesTaskWorkScope(task: WorkItem<WorkTask>, scope: WorkScope): boolean {
  if (isContextTaskFilter(scope)) {
    return task.name === scope.taskName
  }
  if (scope.serviceNames) {
    return false
  }
  if (scope.names) {
    return scope.names.includes(task.name)
  }

  return appliesToLabels(task.data.labels, scope)
}

function matchesServiceWorkScope(service: WorkService, scope: WorkScope): boolean {
  if (isContextTaskFilter(scope)) {
    return false
  }
  if (scope.serviceNames) {
    return scope.serviceNames.includes(service.name)
  }
  if (scope.names) {
    return scope.names.includes(service.name)
  }

  return appliesToLabels(service.labels, scope)
}
