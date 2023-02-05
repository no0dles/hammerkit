import { Environment } from './executer/environment'
import { iterateWorkNodes, iterateWorkServices } from './planner/utils/plan-work-nodes'
import { watchNode } from './executer/watch-node'
import { isContainerWorkService } from './planner/work-service'
import { watchService } from './executer/watch-service'
import { State } from './executer/state'
import { ProcessManager } from './executer/process-manager'
import { isContainerWorkServiceItem } from './planner/work-item'

export function startWatchProcesses(state: State, processManager: ProcessManager, environment: Environment) {
  for (const nodeState of iterateWorkNodes(state.current.node)) {
    if (nodeState.node.data.src.length > 0) {
      processManager.background(nodeState.node, watchNode(nodeState.node, state, processManager, environment), 'watch')
    }
  }
  for (const serviceState of iterateWorkServices(state.current.service)) {
    if (!isContainerWorkServiceItem(serviceState.service)) {
      continue
    }
    if (serviceState.service.data.mounts.length > 0) {
      processManager.background(
        serviceState.service,
        watchService(serviceState.service, state, processManager, environment),
        'watch'
      )
    }
  }
}
