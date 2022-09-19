import { listenOnAbort } from '../utils/abort-event'
import {
  NodeCrashEvent,
  NodeCanceledEvent,
  NodeCompletedEvent,
  NodeErrorEvent,
  SchedulerInitializeEvent,
  ServiceCancelledEvent,
  ServiceCrashEvent,
  ServiceReadyEvent,
} from './events'
import { EventBus } from './event-bus'
import { iterateWorkNodes, iterateWorkServices } from '../planner/utils/plan-work-nodes'
import { Environment } from './environment'
import { getDuration } from './states'
import { SchedulerState } from './scheduler/scheduler-state'
import { watchNode } from './scheduler/watch-node'
import { dequeueServices, enqueueNext } from './scheduler/enqueue-next'
import { abort } from './scheduler/abort-action'
import { checkForLoop } from './scheduler/check-for-loop'
import { finalize } from './scheduler/finalize-action'

async function updateState(eventBus: EventBus, state: SchedulerState, action: () => void): Promise<void> {
  action()
  await eventBus.emit({
    type: 'scheduler-update',
    state,
  })
}

export function attachScheduler(eventBus: EventBus, environment: Environment) {
  const state: SchedulerState = {
    abort: false,
    service: {},
    node: {},
    cacheMethod: 'none',
    noContainer: false,
    watch: false,
    workers: 0,
  }

  eventBus.on<SchedulerInitializeEvent>('scheduler-initialize', async (evt) => {
    state.cacheMethod = evt.cacheMethod
    state.noContainer = evt.noContainer
    state.watch = evt.watch
    state.workers = evt.workers

    if (state.abort) {
      await eventBus.emit({
        type: 'scheduler-termination',
        state,
        success: false,
      })
      return
    }

    for (const node of iterateWorkNodes(evt.nodes)) {
      await updateState(eventBus, state, () => {
        state.node[node.id] = {
          type: 'pending',
          node: node,
        }
      })

      if (evt.watch) {
        await watchNode(state, eventBus, node, environment)
      }
    }

    checkForLoop(state)
    if (state.abort) {
      await finalize(state, eventBus)
      return
    }

    for (const service of iterateWorkServices(evt.services)) {
      await updateState(eventBus, state, () => {
        state.service[service.id] = {
          type: 'pending',
          service,
        }
      })
    }

    await enqueueNext(state, eventBus, environment)
  })

  eventBus.on<NodeCanceledEvent>('node-canceled', async (evt) => {
    await updateState(eventBus, state, () => {
      state.node[evt.node.id] = {
        type: 'canceled',
        node: evt.node,
      }
    })
    await finalize(state, eventBus)
  })
  eventBus.on<NodeErrorEvent>('node-error', async (evt) => {
    await updateState(eventBus, state, () => {
      state.node[evt.node.id] = {
        type: 'error',
        node: evt.node,
        errorMessage: evt.errorMessage,
      }
    })
    abort(state)
    await finalize(state, eventBus)
  })
  eventBus.on<NodeCrashEvent>('node-crash', async (evt) => {
    await updateState(eventBus, state, () => {
      state.node[evt.node.id] = {
        type: 'crash',
        node: evt.node,
        exitCode: evt.exitCode,
      }
    })
    if (!state.watch) {
      abort(state)
    }
    await finalize(state, eventBus)
  })
  eventBus.on<NodeCompletedEvent>('node-completed', async (evt) => {
    state.node[evt.node.id] = {
      type: 'completed',
      node: evt.node,
      duration: getDuration(state.node[evt.node.id]),
    }
    await dequeueServices(state, eventBus, environment)
    await enqueueNext(state, eventBus, environment)
  })
  eventBus.on<ServiceReadyEvent>('service-ready', async (evt) => {
    const currentState = state.service[evt.service.id]
    if (currentState.type !== 'running') {
      throw new Error('service must be in running state')
    }
    await updateState(eventBus, state, () => {
      state.service[evt.service.id] = {
        type: 'ready',
        service: evt.service,
        abortController: currentState.abortController,
        containerId: evt.containerId,
      }
    })
    await enqueueNext(state, eventBus, environment)
  })
  eventBus.on<ServiceCrashEvent>('service-crash', async (evt) => {
    await updateState(eventBus, state, () => {
      state.service[evt.service.id] = {
        type: 'end',
        service: evt.service,
        reason: 'crash',
      }
    })
    abort(state)
    await finalize(state, eventBus)
  })
  eventBus.on<ServiceCancelledEvent>('service-cancelled', async (evt) => {
    await updateState(eventBus, state, () => {
      state.service[evt.service.id] = {
        type: 'end',
        service: evt.service,
        reason: 'cancelled',
      }
    })
    await finalize(state, eventBus)
  })

  listenOnAbort(environment.abortCtrl.signal, () => {
    abort(state)
  })
}
