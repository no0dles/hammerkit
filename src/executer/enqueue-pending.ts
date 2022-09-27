import { SchedulerState } from './scheduler/scheduler-state'
import { Environment } from './environment'
import { UpdateEmitter } from './emitter'
import { HammerkitEvent } from './events'
import { checkIfUpToDate } from './scheduler/enqueue-next'
import { dockerService } from './docker-service'
import { isContainerWorkNode } from '../planner/work-node'
import { dockerNode } from './docker-node'
import { localNode } from './local-node'

export async function enqueuePending(
  state: SchedulerState,
  environment: Environment,
  emitter: UpdateEmitter<HammerkitEvent>
): Promise<void> {
  if (environment.abortCtrl.signal.aborted) {
    return
  }

  for (const [, nodeState] of Object.entries(state.node)) {
    if (nodeState.type === 'pending') {
      const runningNodeCount = Object.values(state.node).filter((n) => n.type === 'running').length
      if (state.workers !== 0 && runningNodeCount >= state.workers) {
        return
      }

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
        emitter.emit({
          type: 'node-cached',
          node: nodeState.node,
        })
        continue
      }

      if (pendingNeeds.length > 0) {
        for (const pendingNeed of pendingNeeds) {
          emitter.emit({
            type: 'service-start',
            service: pendingNeed,
            abortController: emitter.task(`service:${pendingNeed.id}`, dockerService(pendingNeed)),
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

      emitter.emit({
        type: 'node-start',
        node: nodeState.node,
        abortController:
          isContainerWorkNode(nodeState.node) && !state.noContainer
            ? emitter.task(`node:${nodeState.node.id}`, dockerNode(nodeState.node, serviceContainers, environment))
            : emitter.task(`node:${nodeState.node.id}`, localNode(nodeState.node, environment)),
      })
    }
  }

  for (const [serviceId, serviceState] of Object.entries(state.service)) {
    if (serviceState.type !== 'ready' && serviceState.type !== 'running') {
      continue
    }

    let hasNeed = false
    for (const nodeState of Object.values(state.node)) {
      if (nodeState.type === 'running' || nodeState.type === 'pending') {
        if (nodeState.node.needs.some((n) => n.id === serviceId)) {
          hasNeed = true
        }
      }
    }

    if (!hasNeed) {
      serviceState.abortController.abort()
    }
  }
}