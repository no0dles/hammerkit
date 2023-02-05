import { WorkNode } from './work-node'
import { WorkNodeValidation } from './work-node-validation'
import { Environment } from '../executer/environment'
import { WorkTree } from './work-tree'
import { KubernetesWorkService, WorkService } from './work-service'
import { read } from '../parser/read-build-file'
import { iterateWorkNodes, iterateWorkServices } from './utils/plan-work-nodes'
import { WorkItem } from './work-item'

export async function* validate(workTree: WorkTree, context: Environment): AsyncGenerator<WorkNodeValidation> {
  const cycleNodes: WorkItem<WorkNode | WorkService>[] = []

  for (const item of iterateWorkServices(workTree.services)) {
    const service = item.data
    if (!service.description) {
      yield { type: 'warn', message: `missing description`, node: service }
    }
    if (service.type === 'container-service') {
      if (!service.healthcheck) {
        yield { type: 'warn', message: 'missing healthcheck', node: service }
      }

      for (const mount of service.mounts) {
        if (!(await context.file.exists(mount.localPath))) {
          yield {
            type: 'warn',
            message: `mount ${mount.localPath} does not exist`,
            node: service,
          }
        }
      }
    } else {
      if (!(await context.file.exists(service.kubeconfig))) {
        yield {
          type: 'warn',
          message: `kubeconfig ${service.kubeconfig} does not exist`,
          node: service,
        }
      } else if (!(await checkIfContextExists(service, context))) {
        yield {
          type: 'warn',
          message: `context ${service.context} does not exist in kubeconfig ${service.kubeconfig}`,
          node: service,
        }
      }
    }

    // TODO
    // for (const key of Object.keys(service.scope.unknownProps)) {
    //   yield {
    //     type: 'warn',
    //     message: `${key} is an unknown configuration`,
    //     node: service,
    //   }
    // }
  }

  for (const item of iterateWorkNodes(workTree.nodes)) {
    const node = item.data
    if (!node.description) {
      yield { type: 'warn', message: `missing description`, node: node }
    }

    if ((!node.cmds || node.cmds.length === 0) && (!item.deps || item.deps.length === 0)) {
      yield { type: 'warn', message: `task is empty`, node: node }
    }

    for (const src of node.src) {
      if (!(await context.file.exists(src.absolutePath))) {
        yield {
          type: 'warn',
          message: `src ${src.absolutePath} does not exist`,
          node: node,
        }
      }
    }

    // TODO
    // for (const key of Object.keys(node.plannedTask.buildTask.unknownProps)) {
    //   yield {
    //     type: 'warn',
    //     message: `${key} is an unknown configuration`,
    //     node: node,
    //   }
    // }

    if (cycleNodes.indexOf(item) === -1) {
      const cyclePath = hasDependencyCycle(item, [])
      if (cyclePath) {
        cycleNodes.push(...cyclePath)
        yield { type: 'error', message: `task cycle detected ${cyclePath.map((n) => n.name).join(' -> ')}`, node: node }
      }
    }
  }
  // TODO check for deps of needs and needs of deps
}

export function hasNeedCycle(
  node: WorkItem<WorkNode | WorkService>,
  currentPath: WorkItem<WorkNode | WorkService>[]
): WorkItem<any>[] | null {
  if (currentPath.indexOf(node) >= 0) {
    return [...currentPath, node]
  }

  for (const dep of node.needs) {
    const depHasCycle = hasNeedCycle(dep.service, [...currentPath, node])
    if (depHasCycle) {
      return depHasCycle
    }
  }

  return null
}

export function hasDependencyCycle(
  node: WorkItem<WorkNode | WorkService>,
  currentPath: WorkItem<WorkNode | WorkService>[]
): WorkItem<WorkNode | WorkService>[] | null {
  if (currentPath.indexOf(node) >= 0) {
    return [...currentPath, node]
  }

  for (const dep of node.deps) {
    const depHasCycle = hasDependencyCycle(dep, [...currentPath, node])
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
