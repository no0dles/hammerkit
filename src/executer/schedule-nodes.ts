import { SchedulerState } from './scheduler/scheduler-state'
import { State } from './state'
import { ProcessManager } from './process-manager'
import { Environment } from './environment'
import { startNode } from './start-node'
import { ensureNeeds } from './ensure-needs'
import { getServiceContainers } from './get-service-containers'
import { logContext } from '../planner/work-node-status'
import { isContainerWorkNode } from '../planner/work-node'
import { dockerNode } from './docker-node'
import { localNode } from './local-node'
import { iterateWorkNodes } from '../planner/utils/plan-work-nodes'
import { isContainerWorkTaskItem, isLocalWorkTaskItem } from '../planner/work-item'

export function scheduleNodes(
  currentState: SchedulerState,
  state: State,
  processManager: ProcessManager,
  environment: Environment
) {
  for (const nodeState of iterateWorkNodes(currentState.node)) {
    if (nodeState.type === 'pending') {
      const hasOpenDeps = nodeState.node.deps.some((dep) => currentState.node[dep.id].type !== 'completed')
      if (hasOpenDeps) {
        continue
      }

      state.patchNode(
        {
          type: 'starting',
          node: nodeState.node,
          itemId: nodeState.itemId,
          started: new Date(),
          stateKey: null,
        },
        nodeState.stateKey
      )

      processManager.background(
        nodeState.node,
        async (abort) => {
          await startNode(nodeState, state, environment, abort.signal)
        },
        'cache'
      )
    } else if (nodeState.type === 'ready') {
      if (!ensureNeeds(nodeState, nodeState.node.needs, processManager, state, environment, currentState)) {
        continue
      }

      const serviceContainers = getServiceContainers(currentState, nodeState.node.needs)

      state.patchNode(
        {
          type: 'running',
          node: nodeState.node,
          stateKey: nodeState.stateKey,
          started: nodeState.started,
          itemId: nodeState.itemId,
        },
        nodeState.stateKey
      )
      if (isContainerWorkTaskItem(nodeState.node)) {
        processManager.task(
          nodeState.node,
          dockerNode(nodeState.node, nodeState.stateKey, serviceContainers, state, environment)
        )
      } else if (isLocalWorkTaskItem(nodeState.node)) {
        processManager.task(nodeState.node, localNode(nodeState.node, nodeState.stateKey, state, environment))
      }
    }
  }
}
