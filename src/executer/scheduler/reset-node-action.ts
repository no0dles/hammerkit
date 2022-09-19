import { SchedulerState } from './scheduler-state'
import { EventBus } from '../event-bus'
import { WorkNode } from '../../planner/work-node'
import { enqueueNext } from './enqueue-next'
import { Environment } from '../environment'

export async function resetNode(
  state: SchedulerState,
  environment: Environment,
  eventBus: EventBus,
  node: WorkNode
): Promise<void> {
  const nodeState = state.node[node.id]
  if (nodeState.type === 'running') {
    nodeState.abortController.abort()
    await nodeState.result
  }
  state.node[node.id] = {
    type: 'pending',
    node,
  }
  await enqueueNext(state, eventBus, environment)
}
