import { checkCacheState } from './scheduler/enqueue-next'
import { getDuration } from './states'
import { Environment } from './environment'
import { State } from './state'
import { isContainerWorkService, WorkService } from '../planner/work-service'
import { getServiceNodeCacheStats, getStateKey } from '../optimizer/get-work-node-cache-stats'
import { NodeState } from './scheduler/node-state'

export async function startNode(node: NodeState, state: State, environment: Environment): Promise<void> {
  const cacheState = await checkCacheState(node.node, state.current.cacheMethod, environment)
  const currentState = state.current.node[node.node.id]

  if (!!currentState.stateKey && currentState.stateKey !== cacheState.stateKey) {
    const status = environment.status.task(node.node)
    status.write('debug', `cache check for ${node.node.name} no longer valid, skipping result`)
    return
  }

  if (cacheState.cached) {
    state.patchNode(
      {
        type: 'completed',
        node: node.node,
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
        node: node.node,
        stateKey: cacheState.stateKey,
        started: currentState.type === 'starting' ? currentState.started : new Date(),
      },
      node.stateKey
    )
  }
}

export async function startService(service: WorkService, state: State, environment: Environment): Promise<void> {
  if (!isContainerWorkService(service)) {
    state.patchService({
      type: 'ready',
      service,
      stateKey: '', // TODO statekey from kube config
    })
    return
  }

  const fileStats = await getServiceNodeCacheStats(service, environment)
  const fileStateKey = getStateKey(fileStats, 'checksum')
  const currentState = state.current.service[service.id]

  if (!!currentState.stateKey && currentState.stateKey !== fileStateKey) {
    const status = environment.status.service(service)
    status.write('debug', `cache check for ${service.name} no longer valid, skipping result`)
    return
  }

  state.patchService({
    type: 'ready',
    service,
    stateKey: fileStateKey,
  })
}
