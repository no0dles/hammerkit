import { checkCacheState } from './scheduler/enqueue-next'
import { getDuration } from './states'
import { Environment } from './environment'
import { isContainerWorkService, WorkService } from '../planner/work-service'
import { getStateKey, getWorkCacheStats } from '../optimizer/get-work-node-cache-stats'
import { NodeState } from './scheduler/node-state'
import { ServiceDns } from './service-dns'
import { WorkItemState } from '../planner/work-item'
import { CliExecOptions } from '../cli'
import { WorkNode } from '../planner/work-node'
import { ServiceState } from './scheduler/service-state'

export async function startNode(
  node: WorkItemState<WorkNode, NodeState>,
  environment: Environment,
  options: CliExecOptions,
  abortSignal: AbortSignal
): Promise<void> {
  const cacheState = await checkCacheState(node, options.cacheDefault, environment)

  if (abortSignal.aborted) {
    return
  }

  if (!!node.state.current.stateKey && node.state.current.stateKey !== cacheState.stateKey) {
    node.status.write('debug', `cache check for ${node.name} no longer valid, skipping result`)
    return
  }

  if (cacheState.cached) {
    node.state.set({
      type: 'completed',
      cached: true,
      stateKey: cacheState.stateKey,
      duration: node.state.current.type === 'starting' ? getDuration(node.state.current.started) : 0,
    })
  } else {
    node.state.set({
      type: 'ready',
      stateKey: cacheState.stateKey,
      started: node.state.current.type === 'starting' ? node.state.current.started : new Date(),
    })
  }
}

export async function startService(
  item: WorkItemState<WorkService, ServiceState>,
  serviceContainers: { [key: string]: ServiceDns },
  environment: Environment,
  options: CliExecOptions,
  abortSignal: AbortSignal
): Promise<void> {
  const service = item.data
  const currentStats = await getWorkCacheStats(service, environment)
  const stateKey = getStateKey(currentStats, options.cacheDefault)

  if (abortSignal.aborted) {
    return
  }

  if (!isContainerWorkService(service)) {
    item.state.set({
      type: 'ready',
      stateKey,
    })
    return
  }

  const fileStats = await getWorkCacheStats(service, environment)
  const fileStateKey = getStateKey(fileStats, 'checksum')

  if (!!item.state.current.stateKey && item.state.current.stateKey !== fileStateKey) {
    item.status.write('debug', `cache check for ${service.name} no longer valid, skipping result`)
    return
  }

  item.state.set({
    type: 'ready',
    stateKey: fileStateKey,
  })
}
