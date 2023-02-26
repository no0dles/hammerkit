import { ReferencedContext } from './reference-parser'
import { isContextTaskFilter, WorkScope } from '../executer/work-scope'
import { WorkTree } from '../planner/work-tree'
import { appliesToLabels } from '../executer/label-values'
import { appendWorkService } from '../planner/utils/append-work-service'
import { appendWorkNode } from '../planner/utils/append-work-node'
import { Environment } from '../executer/environment'
import { WorkService } from '../planner/work-service'
import { WorkNode } from '../planner/work-node'
import { WorkItem, WorkItemState } from '../planner/work-item'
import { appendWorkEnvironment } from '../planner/utils/append-work-environment'
import { NodeState } from '../executer/scheduler/node-state'
import { ServiceState } from '../executer/scheduler/service-state'

export function getWorkContext(context: ReferencedContext, scope: WorkScope, environment: Environment): WorkTree {
  const workTree: WorkTree = { services: {}, environments: {}, nodes: {} }
  const filteredWorkTree: WorkTree = { services: {}, environments: {}, nodes: {} }

  for (const task of Object.values(context.tasks)) {
    const item = appendWorkNode(workTree, task.cwd, task, environment)
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

function applyTask(workTree: WorkTree, item: WorkItemState<WorkNode, NodeState>) {
  if (workTree.nodes[item.name]) {
    return
  }
  workTree.nodes[item.name] = item
  applyNeedsAndDeps(workTree, item)
}
function applyService(workTree: WorkTree, item: WorkItemState<WorkService, ServiceState>) {
  if (workTree.services[item.name]) {
    return
  }
  workTree.services[item.name] = item
  applyNeedsAndDeps(workTree, item)
}

function applyNeedsAndDeps(workTree: WorkTree, item: WorkItem<WorkNode | WorkService>) {
  for (const dep of item.deps) {
    applyTask(workTree, dep)
  }
  for (const need of item.needs) {
    applyService(workTree, need.service)
  }
}

function matchesTaskWorkScope(task: WorkItem<WorkNode>, scope: WorkScope): boolean {
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
