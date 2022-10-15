import { ServiceDns } from './events'
import { Environment } from './environment'
import { SchedulerResult } from './scheduler/scheduler-result'
import { isContainerWorkService } from '../planner/work-service'
import { dockerService } from './docker-service'
import { kubernetesService } from './kubernetes-service'
import { isContainerWorkNode } from '../planner/work-node'
import { dockerNode } from './docker-node'
import { localNode } from './local-node'
import { State } from './state'
import { ProcessManager } from './process-Manager'
import { logContext } from '../planner/work-node-status'

export async function schedule(
  processManager: ProcessManager,
  state: State,
  environment: Environment
): Promise<SchedulerResult> {
  state.on((currentState) => {
    for (const [, nodeState] of Object.entries(currentState.node)) {
      if (nodeState.type === 'pending') {
        const pendingNeeds = nodeState.node.needs
          .map((need) => currentState.service[need.id])
          .filter((service) => service.type === 'pending')

        const hasOpenDeps = nodeState.node.deps.some((dep) => currentState.node[dep.id].type !== 'completed')

        if (hasOpenDeps) {
          continue
        }

        if (pendingNeeds.length > 0) {
          for (const pendingNeed of pendingNeeds) {
            const ctx = logContext('service', pendingNeed.service)
            state.patchService({
              type: 'running',
              service: pendingNeed.service,
              abortController: processManager.task(
                ctx,
                isContainerWorkService(pendingNeed.service)
                  ? dockerService(pendingNeed.service, state, environment)
                  : kubernetesService(pendingNeed.service, state, environment)
              ),
            })
          }
          continue
        }

        const hasNotReadyNeeds = nodeState.node.needs.some((need) => currentState.service[need.id].type !== 'ready')
        if (hasNotReadyNeeds) {
          continue
        }

        const serviceContainers: { [key: string]: ServiceDns } = {}
        for (const need of nodeState.node.needs) {
          const serviceState = currentState.service[need.id]
          if (serviceState.type === 'ready') {
            serviceContainers[need.id] = serviceState.dns
          }
        }

        const ctx = logContext('task', nodeState.node)
        state.patchNode({
          type: 'running',
          node: nodeState.node,
          started: new Date(),
          abortController:
            isContainerWorkNode(nodeState.node) && !currentState.noContainer
              ? processManager.task(ctx, dockerNode(nodeState.node, serviceContainers, state, environment))
              : processManager.task(ctx, localNode(nodeState.node, state, environment)),
        })
      }
    }

    for (const [serviceId, serviceState] of Object.entries(currentState.service)) {
      if (serviceState.type !== 'ready' && serviceState.type !== 'running') {
        continue
      }

      let hasNeed = false
      for (const nodeState of Object.values(currentState.node)) {
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
  })

  await processManager.onComplete()

  const success = !Object.values(state.current.node).some((n) => n.type !== 'completed')
  return {
    state: state.current,
    success,
  }
}
