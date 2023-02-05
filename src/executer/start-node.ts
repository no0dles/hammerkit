import { checkCacheState } from './scheduler/enqueue-next'
import { getDuration } from './states'
import { Environment } from './environment'
import { State } from './state'
import { isContainerWorkService, WorkService } from '../planner/work-service'
import { getServiceNodeCacheStats, getStateKey } from '../optimizer/get-work-node-cache-stats'
import { NodeState } from './scheduler/node-state'
import { ServiceDns } from './service-dns'
import { WorkItem } from '../planner/work-item'

export async function startNode(
  node: NodeState,
  state: State,
  environment: Environment,
  abortSignal: AbortSignal
): Promise<void> {
  const cacheState = await checkCacheState(node.node, state.current.cacheMethod, environment)
  const currentState = state.current.node[node.node.id]

  if (abortSignal.aborted) {
    return
  }

  if (!!currentState.stateKey && currentState.stateKey !== cacheState.stateKey) {
    node.node.status.write('debug', `cache check for ${node.node.name} no longer valid, skipping result`)
    return
  }

  if (cacheState.cached) {
    state.patchNode(
      {
        type: 'completed',
        node: node.node,
        itemId: node.itemId,
        cached: true,
        stateKey: cacheState.stateKey,
        duration: currentState.type === 'starting' ? getDuration(currentState.started) : 0,
      },
      node.stateKey
    )
  } else {
    state.patchNode(
      {
        type: 'ready',
        itemId: node.itemId,
        node: node.node,
        stateKey: cacheState.stateKey,
        started: currentState.type === 'starting' ? currentState.started : new Date(),
      },
      node.stateKey
    )
  }
}

export async function startService(
  item: WorkItem<WorkService>,
  state: State,
  serviceContainers: { [key: string]: ServiceDns },
  environment: Environment,
  abortSignal: AbortSignal
): Promise<void> {
  const service = item.data
  const currentStats = await getServiceNodeCacheStats(service, environment)
  const stateKey = getStateKey(currentStats, state.current.cacheMethod)

  if (abortSignal.aborted) {
    return
  }

  if (!isContainerWorkService(service)) {
    state.patchService({
      type: 'ready',
      service: item,
      stateKey,
      itemId: item.id,
    })
    return
  }

  const fileStats = await getServiceNodeCacheStats(service, environment)
  const fileStateKey = getStateKey(fileStats, 'checksum')
  const currentState = state.current.service[item.id]

  if (!!currentState.stateKey && currentState.stateKey !== fileStateKey) {
    item.status.write('debug', `cache check for ${service.name} no longer valid, skipping result`)
    return
  }

  state.patchService({
    type: 'ready',
    service: item,
    stateKey: fileStateKey,
    itemId: item.id,
  })
}
