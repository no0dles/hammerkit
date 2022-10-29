import { Environment } from './executer/environment'
import { iterateWorkNodes, iterateWorkServices } from './planner/utils/plan-work-nodes'
import { watchNode } from './executer/watch-node'
import { isContainerWorkService } from './planner/work-service'
import { watchService } from './executer/watch-service'
import { State } from './executer/state'
import { ProcessManager } from './executer/process-manager'
import { logContext } from './planner/work-node-status'

export function startWatchProcesses(state: State, processManager: ProcessManager, environment: Environment) {
  for (const node of iterateWorkNodes(state.current.node)) {
    if (node.node.src.length > 0) {
      if (node.node.continuous) {
        environment.status.task(node.node).write('debug', 'do not start files watches for continuous task')
        continue
      }
      processManager.background(logContext('task', node.node), watchNode(node.node, state, environment))
    }
  }
  for (const service of iterateWorkServices(state.current.service)) {
    if (!isContainerWorkService(service.service)) {
      continue
    }
    if (service.service.mounts.length > 0) {
      processManager.background(
        logContext('service', service.service),
        watchService(service.service, state, environment)
      )
    }
  }
}
