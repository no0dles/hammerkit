import { Environment } from './executer/environment'
import { iterateWorkNodes, iterateWorkServices } from './planner/utils/plan-work-nodes'
import { watchNode } from './executer/watch-node'
import { isContainerWorkService } from './planner/work-service'
import { watchService } from './executer/watch-service'
import { State } from './executer/state'
import { ProcessManager } from './executer/process-manager'

export function startWatchProcesses(state: State, processManager: ProcessManager, environment: Environment) {
  for (const node of iterateWorkNodes(state.current.node)) {
    if (node.node.src.length > 0) {
      if (node.node.continuous) {
        environment.status.task(node.node).write('debug', 'do not start files watches for continuous task')
        continue
      }
      processManager.background(
        { type: 'task', id: node.node.id + '-watch', name: node.node.name },
        watchNode(node.node, state, processManager, environment)
      )
    }
  }
  for (const service of iterateWorkServices(state.current.service)) {
    if (!isContainerWorkService(service.service)) {
      continue
    }
    if (service.service.mounts.length > 0) {
      processManager.background(
        { type: 'service', id: service.service.id + '-watch', name: service.service.name },
        watchService(service.service, state, processManager, environment)
      )
    }
  }
}
