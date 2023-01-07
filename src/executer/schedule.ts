import { ServiceDns } from './service-dns'
import { Environment } from './environment'
import { SchedulerResult } from './scheduler/scheduler-result'
import { isContainerWorkService, WorkService } from '../planner/work-service'
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
import { iterateWorkNodes, iterateWorkServices } from '../planner/utils/plan-work-nodes'
import { SchedulerState } from './scheduler/scheduler-state'
import { NodeState } from './scheduler/node-state'
import { isServiceState, ServiceState } from './scheduler/service-state'

function ensureNeeds(
  nodeOrServiceState: NodeState | ServiceState,
  needs: WorkService[],
  processManager: ProcessManager,
  state: State,
  environment: Environment,
  currentState: SchedulerState
): boolean {
  const endedNeeds = needs
    .map((need) => currentState.service[need.id])
    .filter((service) => service.type === 'end' || service.type === 'canceled')
  if (endedNeeds.length > 0) {
    if (isServiceState(nodeOrServiceState)) {
      state.patchService({
        type: 'error',
        service: nodeOrServiceState.service,
        stateKey: nodeOrServiceState.stateKey,
        errorMessage: endedNeeds
          .map((n) => `service ${n.service.name} ${n.type === 'end' ? 'has ended ' + n.reason : 'was canceled'}`)
          .join(', '),
      })
    } else {
      state.patchNode(
        {
          type: 'error',
          node: nodeOrServiceState.node,
          stateKey: nodeOrServiceState.stateKey,
          errorMessage: endedNeeds
            .map((n) => `service ${n.service.name} ${n.type === 'end' ? 'has ended ' + n.reason : 'was canceled'}`)
            .join(', '),
        },
        nodeOrServiceState.stateKey
      )
    }
    return false
  }

  const pendingNeeds = needs
    .map((need) => currentState.service[need.id])
    .filter((service) => service.type === 'pending')

  if (pendingNeeds.length > 0) {
    for (const pendingNeed of pendingNeeds) {
      if (!ensureNeeds(pendingNeed, pendingNeed.service.needs, processManager, state, environment, currentState)) {
        continue
      }

      state.patchService({
        type: 'starting',
        service: pendingNeed.service,
        stateKey: null,
      })

      const serviceContainers = getServiceContainers(currentState, pendingNeed.service.needs)

      processManager.background(
        {
          type: 'service',
          name: pendingNeed.service.name,
          id: pendingNeed.service.id + '-cache',
        },
        async (abort) => {
          await startService(pendingNeed.service, state, serviceContainers, environment, abort.signal)
        }
      )
    }
    return false
  }

  const hasNotReadyNeeds = needs.some((need) => currentState.service[need.id].type !== 'running')
  if (hasNotReadyNeeds) {
    return false
  }

  return true
}

export function getServiceContainers(
  currentState: SchedulerState,
  needs: WorkService[]
): { [key: string]: ServiceDns } {
  const serviceContainers: { [key: string]: ServiceDns } = {}
  for (const need of needs) {
    const serviceState = currentState.service[need.id]
    if (serviceState.type === 'running') {
      serviceContainers[need.id] = serviceState.dns
    }
  }
  return serviceContainers
}

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
      const hasOpenDeps = serviceState.service.deps.some((dep) => currentState.node[dep.id].type !== 'completed')
      if (hasOpenDeps) {
        continue
      }

      if (serviceState.type === 'ready') {
        const ctx = logContext('service', serviceState.service)
        state.patchService({
          type: 'starting',
          service: serviceState.service,
          stateKey: serviceState.stateKey,
        })

        const serviceContainers = getServiceContainers(currentState, serviceState.service.needs)
        processManager.background(
          ctx,
          isContainerWorkService(serviceState.service)
            ? dockerService(serviceState.service, serviceState.stateKey, serviceContainers, state, environment)
            : kubernetesService(serviceState.service, serviceState.stateKey, state, environment)
        )
      }

      if (serviceState.type !== 'ready' && serviceState.type !== 'running') {
        continue
      }

      let hasNeed = false
      for (const nodeState of iterateWorkNodes(currentState.node)) {
        if (nodeState.type === 'running' || nodeState.type === 'starting' || nodeState.type === 'pending') {
          if (nodeState.node.needs.some((n) => n.id === serviceId)) {
            hasNeed = true
            break
          }
        }
      }

      if (!hasNeed) {
        for (const serviceState of iterateWorkServices(currentState.service)) {
          if (
            serviceState.type === 'ready' ||
            serviceState.type === 'running' ||
            serviceState.type === 'starting' ||
            serviceState.type === 'pending'
          ) {
            if (serviceState.service.needs.some((n) => n.id === serviceId)) {
              hasNeed = true
              break
            }
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
