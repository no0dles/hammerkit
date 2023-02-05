import { ReferencedContext, ReferenceService, ReferenceTask } from './reference-parser'
import { isContextTaskFilter, WorkScope } from '../executer/work-scope'
import { WorkTree } from '../planner/work-tree'
import { appliesToLabels } from '../executer/label-values'
import { appendWorkService } from '../planner/utils/append-work-service'
import { appendWorkNode } from '../planner/utils/append-work-node'
import { Environment } from '../executer/environment'

export function getWorkContext(context: ReferencedContext, scope: WorkScope, environment: Environment): WorkTree {
  const workTree: WorkTree = { services: {}, environments: {}, nodes: {} }

  for (const task of Object.values(context.tasks)) {
    if (matchesTaskWorkScope(task, scope)) {
      appendWorkNode(workTree, task.cwd, task, environment) // TODO decide on work node
    }
  }

  for (const service of Object.values(context.services)) {
    if (matchesServiceWorkScope(service, scope)) {
      appendWorkService(workTree, service, environment) // TODO decide on work service
    }
  }

  return workTree
}

function matchesTaskWorkScope(task: ReferenceTask, scope: WorkScope): boolean {
  if (isContextTaskFilter(scope)) {
    return task.relativeName === scope.taskName
  }

  return appliesToLabels(task.labels, scope)
}

function matchesServiceWorkScope(service: ReferenceService, scope: WorkScope): boolean {
  if (isContextTaskFilter(scope)) {
    return false
  }

  return appliesToLabels(service.labels, scope)
}
