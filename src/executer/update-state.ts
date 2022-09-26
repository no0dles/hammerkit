import { SchedulerState } from './scheduler/scheduler-state'
import { HammerkitEvent } from './events'
import { getDuration } from './states'
import { failNever } from '../utils/fail-never'

export function updateState(current: SchedulerState, evt: HammerkitEvent): SchedulerState {
  if (evt.type === 'node-crash') {
    current.node[evt.node.id] = {
      type: 'crash',
      node: evt.node,
      exitCode: evt.exitCode,
    }
    return current
  } else if (evt.type === 'node-watch-reset') {
    const nodeState = current.node[evt.node.id]
    if (nodeState.type === 'running') {
      nodeState.abortController.abort() // TODO await stop
    }
    current.node[evt.node.id] = {
      type: 'pending',
      node: evt.node,
    }
    return current
  } else if (evt.type === 'node-watch-start') {
    return current
  } else if (evt.type === 'node-watch-canceled') {
    return current
  } else if (evt.type === 'scheduler-update') {
    return current
  } else if (evt.type === 'node-start') {
    current.node[evt.node.id] = {
      type: 'running',
      node: evt.node,
      started: new Date(),
      abortController: evt.abortController,
    }
    return current
  } else if (evt.type === 'node-canceled') {
    current.node[evt.node.id] = {
      type: 'canceled',
      node: evt.node,
    }
    return current
  } else if (evt.type === 'node-completed') {
    const nodeState = current.node[evt.node.id]
    current.node[evt.node.id] = {
      type: 'completed',
      node: evt.node,
      duration: getDuration(nodeState),
    }
    return current
  } else if (evt.type === 'node-error') {
    current.node[evt.node.id] = {
      type: 'error',
      node: evt.node,
      errorMessage: evt.errorMessage,
    }
    return current
  } else if (evt.type === 'node-cached') {
    current.node[evt.node.id] = {
      type: 'completed',
      node: evt.node,
      duration: 0,
    }
    return current
  } else if (evt.type === 'service-canceled') {
    current.service[evt.service.id] = {
      type: 'end',
      service: evt.service,
      reason: 'canceled',
    }
    return current
  } else if (evt.type === 'service-crash') {
    current.service[evt.service.id] = {
      type: 'end',
      service: evt.service,
      reason: 'crash',
    }
    return current
  } else if (evt.type === 'service-start') {
    current.service[evt.service.id] = {
      type: 'running',
      service: evt.service,
      abortController: evt.abortController,
    }
    return current
  } else if (evt.type === 'service-ready') {
    const serviceState = current.service[evt.service.id]
    if (serviceState.type === 'running') {
      current.service[evt.service.id] = {
        type: 'ready',
        service: evt.service,
        containerId: evt.containerId,
        abortController: serviceState.abortController,
      }
    } else {
      throw new Error('') // TODO
    }
    return current
  } else {
    failNever(evt, 'unknown evt type')
  }
}
