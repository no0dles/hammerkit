import { SchedulerState } from './scheduler-state'
import { EventBus } from '../event-bus'
import { isContainerWorkNode, WorkNode } from '../../planner/work-node'
import { readCache } from '../../optimizer/read-work-node-cache'
import { getWorkNodeCacheStats, hasStatsChanged } from '../../optimizer/get-work-node-cache-stats'
import { Environment } from '../environment'
import { CacheMethod } from '../../optimizer/cache-method'

export async function checkIfUpToDate(
  cacheMethod: CacheMethod,
  node: WorkNode,
  environment: Environment
): Promise<boolean> {
  if (cacheMethod === 'none') {
    return false
  }

  const cache = await readCache(node, environment)
  if (!cache) {
    node.status.write('debug', `${node.name} can't be skipped because there is no cache`)
    return false
  }

  const currentStats = await getWorkNodeCacheStats(node, environment)
  const changed = await hasStatsChanged(node, cache, currentStats, cacheMethod)
  if (changed) {
    return false
  }

  node.status.write('debug', `${node.name} is skipped because it's cache is up to date`)
  return true
}

export async function enqueueNext(state: SchedulerState, eventBus: EventBus, environment: Environment) {
  if (state.abort) {
    return
  }

  for (const [nodeId, nodeState] of Object.entries(state.node)) {
    if (nodeState.type === 'pending') {
      const pendingNeeds = nodeState.node.needs.filter((need) => state.service[need.id].type === 'pending')
      const runningNeeds = nodeState.node.needs.filter((need) => state.service[need.id].type === 'running')
      const hasOpenDeps = nodeState.node.deps.some(
        (dep) => state.node[dep.id].type === 'pending' || state.node[dep.id].type === 'running'
      )

      if (hasOpenDeps) {
        continue
      }

      const isUpToDate = await checkIfUpToDate(state.cacheMethod, nodeState.node, environment)
      if (isUpToDate) {
        state.node[nodeId] = {
          type: 'completed',
          node: nodeState.node,
          duration: 0,
        }
        continue
      }

      if (pendingNeeds.length > 0) {
        for (const pendingNeed of pendingNeeds) {
          const abortController = new AbortController()
          state.service[pendingNeed.id] = {
            type: 'running',
            abortController,
            service: pendingNeed,
          }
          await eventBus.emit({
            type: 'scheduler-start-service',
            service: pendingNeed,
            abortSignal: abortController.signal,
          })
        }
        continue
      }

      if (runningNeeds.length > 0) {
        continue
      }

      const serviceContainers: { [key: string]: string } = {}
      for (const need of nodeState.node.needs) {
        const serviceState = state.service[need.id]
        if (serviceState.type === 'ready') {
          serviceContainers[need.id] = serviceState.containerId
        }
      }

      const abortController = new AbortController()
      const result = isContainerWorkNode(nodeState.node)
        ? eventBus.emit({
            type: 'scheduler-start-container-node',
            node: nodeState.node,
            abortSignal: abortController.signal,
            serviceContainers,
          })
        : eventBus.emit({
            type: 'scheduler-start-local-node',
            node: nodeState.node,
            abortSignal: abortController.signal,
          })
      state.node[nodeId] = {
        type: 'running',
        abortController,
        node: nodeState.node,
        result,
        started: new Date(),
      }

      await result
    }
  }
}
