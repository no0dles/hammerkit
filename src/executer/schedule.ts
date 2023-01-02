import { ServiceDns } from './service-dns'
import { Environment } from './environment'
import { SchedulerResult } from './scheduler/scheduler-result'
import { isContainerWorkService } from '../planner/work-service'
import { dockerService } from './docker-service'
import { kubernetesService } from './kubernetes-service'
import { isContainerWorkNode } from '../planner/work-node'
import { dockerNode } from './docker-node'
import { localNode } from './local-node'
import { State } from './state'
import { ProcessManager } from './process-manager'
import { logContext } from '../planner/work-node-status'
import { startWatchProcesses } from '../start-watch-processes'
import { startNode, startService } from './start-node'

export async function schedule(
  processManager: ProcessManager,
  state: State,
  environment: Environment
): Promise<SchedulerResult> {
  if (state.current.watch) {
    startWatchProcesses(state, processManager, environment)
  }

  state.on((currentState) => {
    for (const [, nodeState] of Object.entries(currentState.node)) {
      if (nodeState.type === 'pending') {
        const hasOpenDeps = nodeState.node.deps.some((dep) => currentState.node[dep.id].type !== 'completed')
        if (hasOpenDeps) {
          continue
        }

        state.patchNode(
          {
            type: 'starting',
            node: nodeState.node,
            started: new Date(),
            stateKey: null,
          },
          nodeState.stateKey
        )

        processManager.background(
          {
            type: 'task',
            name: nodeState.node.name,
            id: nodeState.node.id + '-cache',
          },
          async (abort) => {
            await startNode(nodeState, state, environment, abort.signal)
          }
        )
      } else if (nodeState.type === 'ready') {
        const endedNeeds = nodeState.node.needs
          .map((need) => currentState.service[need.id])
          .filter((service) => service.type === 'end' || service.type === 'canceled')
        if (endedNeeds.length > 0) {
          state.patchNode(
            {
              type: 'error',
              node: nodeState.node,
              stateKey: nodeState.stateKey,
              errorMessage: endedNeeds
                .map((n) => `service ${n.service.name} ${n.type === 'end' ? 'has ended ' + n.reason : 'was canceled'}`)
                .join(', '),
            },
            nodeState.stateKey
          )
          continue
        }

        const pendingNeeds = nodeState.node.needs
          .map((need) => currentState.service[need.id])
          .filter((service) => service.type === 'pending')

        if (pendingNeeds.length > 0) {
          for (const pendingNeed of pendingNeeds) {
            state.patchService({
              type: 'starting',
              service: pendingNeed.service,
              stateKey: null,
            })

            processManager.background(
              {
                type: 'service',
                name: pendingNeed.service.name,
                id: pendingNeed.service.id + '-cache',
              },
              async (abort) => {
                await startService(pendingNeed.service, state, environment, abort.signal)
              }
            )
          }
          continue
        }

        const hasNotReadyNeeds = nodeState.node.needs.some((need) => currentState.service[need.id].type !== 'running')
        if (hasNotReadyNeeds) {
          continue
        }

        const serviceContainers: { [key: string]: ServiceDns } = {}
        for (const need of nodeState.node.needs) {
          const serviceState = currentState.service[need.id]
          if (serviceState.type === 'running') {
            serviceContainers[need.id] = serviceState.dns
          }
        }

        state.patchNode(
          {
            type: 'running',
            node: nodeState.node,
            stateKey: nodeState.stateKey,
            started: nodeState.started,
          },
          nodeState.stateKey
        )
        const ctx = logContext('task', nodeState.node)
        if (isContainerWorkNode(nodeState.node)) {
          processManager.task(
            ctx,
            dockerNode(nodeState.node, nodeState.stateKey, serviceContainers, state, environment)
          )
        } else {
          processManager.task(ctx, localNode(nodeState.node, nodeState.stateKey, state, environment))
        }
      }
    }

    for (const [serviceId, serviceState] of Object.entries(currentState.service)) {
      if (serviceState.type === 'ready') {
        const ctx = logContext('service', serviceState.service)
        state.patchService({
          type: 'starting',
          service: serviceState.service,
          stateKey: serviceState.stateKey,
        })
        processManager.background(
          ctx,
          isContainerWorkService(serviceState.service)
            ? dockerService(serviceState.service, serviceState.stateKey, state, environment)
            : kubernetesService(serviceState.service, serviceState.stateKey, state, environment)
        )
      }

      if (serviceState.type !== 'ready' && serviceState.type !== 'running') {
        continue
      }

      let hasNeed = false
      for (const nodeState of Object.values(currentState.node)) {
        if (nodeState.type === 'running' || nodeState.type === 'starting' || nodeState.type === 'pending') {
          if (nodeState.node.needs.some((n) => n.id === serviceId)) {
            hasNeed = true
          }
        }
      }

      if (!hasNeed) {
        const ctx = logContext('service', serviceState.service)
        environment.status.service(serviceState.service).write('info', 'stop unused service')
        processManager.abort(ctx)
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
