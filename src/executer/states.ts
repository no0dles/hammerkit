import { WorkTree } from '../planner/work-tree'
import { iterateWorkNodes } from '../planner/utils/plan-work-nodes'
import {
  WorkNodeAbortedState,
  WorkNodeCancelState,
  WorkNodeCompletedState,
  WorkNodePendingState,
  WorkNodeRunningState,
  WorkNodeState,
} from '../planner/work-node-status'
import { ExecutionContext } from './execution-context'
import { listenOnAbort } from '../utils/abort-event'
import { WorkNode } from '../planner/work-node'
import { ExecutionContextEvent } from './execution-context-event'
import { WorkService } from '../planner/work-service'
import { WorkServiceReadyState, WorkServiceRunningState } from '../planner/work-service-state'

function getDuration(state: WorkNodeState): number {
  if (state.type === 'running') {
    return new Date().getTime() - state.started.getTime()
  }
  return 0
}

export function runNode(workTree: WorkTree, nodeId: string, context: ExecutionContext): AbortController {
  const runningState: WorkNodeRunningState = {
    type: 'running',
    started: new Date(),
    abortCtrl: new AbortController(),
  }

  listenOnAbort(context.environment.abortCtrl.signal, () => {
    runningState.abortCtrl.abort()
  })

  const currentState = workTree.nodes[nodeId].status.state
  workTree.nodes[nodeId].status.state = runningState
  context.events.emit({ type: 'node', oldState: currentState, newState: runningState, nodeId, workTree })
  return runningState.abortCtrl
}

export function completeNode(workTree: WorkTree, nodeId: string, context: ExecutionContext): void {
  const node = workTree.nodes[nodeId]

  const currentState = node.status.state
  const completedState: WorkNodeCompletedState = {
    type: 'completed',
    ended: new Date(),
    duration: getDuration(currentState),
  }
  node.status.state = completedState
  if (!context.watch && !node.status.abortCtrl.signal.aborted) {
    node.status.abortCtrl.abort()
  }

  context.events.emit({ type: 'node', oldState: currentState, newState: completedState, nodeId, workTree })

  for (const otherNode of iterateWorkNodes(workTree.nodes)) {
    if (otherNode.status.state.type !== 'pending') {
      continue
    }

    const pendingDependencies = otherNode.status.state.pendingDependencies
    const dependency = pendingDependencies[node.id]
    if (!dependency) {
      continue
    }

    const newState = getPendingState(otherNode)
    const evt: ExecutionContextEvent = {
      type: 'node',
      oldState: otherNode.status.state,
      nodeId: otherNode.id,
      workTree,
      newState,
    }
    otherNode.status.state = newState
    context.events.emit(evt)
  }
}

export function serviceReady(
  workTree: WorkTree,
  serviceId: string,
  context: ExecutionContext,
  containerName: string
): void {
  const service = workTree.services[serviceId]
  const oldState = service.status.state
  const newState: WorkServiceReadyState = {
    type: 'ready',
    containerName,
  }
  service.status.state = newState
  context.events.emit({ type: 'service', newState, oldState, workTree, serviceId })

  for (const otherNode of iterateWorkNodes(workTree.nodes)) {
    if (otherNode.status.state.type !== 'pending') {
      continue
    }

    const pendingServices = otherNode.status.state.pendingServices
    const dependency = pendingServices[serviceId]
    if (!dependency) {
      continue
    }

    const newState = getPendingState(otherNode)
    const evt: ExecutionContextEvent = {
      type: 'node',
      oldState: otherNode.status.state,
      nodeId: otherNode.id,
      workTree,
      newState,
    }
    otherNode.status.state = newState
    context.events.emit(evt)
  }
}

export function serviceRunning(
  workTree: WorkTree,
  serviceId: string,
  context: ExecutionContext,
  containerName: string
): void {
  const service = workTree.services[serviceId]
  const oldState = service.status.state
  const newState: WorkServiceRunningState = {
    type: 'running',
    containerName,
  }
  service.status.state = newState
  context.events.emit({ type: 'service', newState, oldState, workTree, serviceId })
}

export function failNode(workTree: WorkTree, nodeId: string, context: ExecutionContext, errorMessage: string): void {
  const node = workTree.nodes[nodeId]

  node.status.console.write('internal', 'error', errorMessage)

  const canceledExecution = context.environment.abortCtrl.signal.aborted
  const currentState = node.status.state
  if (currentState.type === 'running') {
    const newState: WorkNodeState = canceledExecution
      ? { type: 'aborted' }
      : { type: 'failed', ended: new Date(), duration: getDuration(node.status.state), errorMessage }
    node.status.state = newState
    context.events.emit({ type: 'node', nodeId: node.id, workTree, newState, oldState: currentState })
  } else if (currentState.type === 'cancel') {
    const newState: WorkNodeState = canceledExecution ? { type: 'aborted' } : getPendingState(node)
    node.status.state = newState
    context.events.emit({ type: 'node', nodeId: node.id, workTree, newState, oldState: currentState })
  }

  if (!canceledExecution && !context.watch) {
    cancelPendingNodes(workTree, nodeId, context)
  }

  if ((canceledExecution || !context.watch) && !node.status.abortCtrl.signal.aborted) {
    node.status.abortCtrl.abort()
  }
}

function getPendingState(node: WorkNode): WorkNodePendingState {
  return {
    type: 'pending',
    pendingDependencies: node.deps.reduce<{ [key: string]: WorkNode }>((map, dep) => {
      if (dep.status.state.type !== 'completed') {
        map[dep.id] = dep
      }
      return map
    }, {}),
    pendingServices: node.needs.reduce<{ [key: string]: WorkService }>((map, service) => {
      if (service.status.state.type !== 'ready') {
        map[service.id] = service
      }
      return map
    }, {}),
  }
}

export function resetNode(workTree: WorkTree, nodeId: string, context: ExecutionContext): void {
  const node = workTree.nodes[nodeId]

  const currentState = node.status.state
  if (currentState.type === 'running') {
    const cancelState: WorkNodeCancelState = { type: 'cancel' }
    node.status.state = cancelState
    currentState.abortCtrl.abort()
    context.events.emit({ type: 'node', workTree, nodeId, oldState: currentState, newState: cancelState })
  } else if (currentState.type === 'completed' || currentState.type === 'failed') {
    const pendingState = getPendingState(node)
    node.status.state = pendingState
    context.events.emit({ type: 'node', workTree, nodeId, oldState: currentState, newState: pendingState })
  }
}

function cancelPendingNodes(workTree: WorkTree, nodeId: string, context: ExecutionContext) {
  for (const node of iterateWorkNodes(workTree.nodes)) {
    if (node.status.state.type !== 'pending') {
      continue
    }

    if (!node.status.state.pendingDependencies[nodeId]) {
      continue
    }

    const currentState = node.status.state
    if (currentState.type === 'pending') {
      const cancelState: WorkNodeCancelState = { type: 'cancel' }
      node.status.state = cancelState
      context.events.emit({ type: 'node', workTree, nodeId, oldState: currentState, newState: cancelState })
      if (!context.watch) {
        node.status.abortCtrl.abort()
      }
      cancelPendingNodes(workTree, node.id, context)
    }
  }
}

export function cancelNodes(workTree: WorkTree, context: ExecutionContext): void {
  for (const node of iterateWorkNodes(workTree.nodes)) {
    const currentState = node.status.state
    if (currentState.type === 'pending') {
      const abortState: WorkNodeAbortedState = { type: 'aborted' }
      node.status.state = abortState
      node.status.abortCtrl.abort()
      context.events.emit({ type: 'node', nodeId: node.id, workTree, newState: abortState, oldState: currentState })
    } else if (currentState.type === 'running') {
      const cancelState: WorkNodeCancelState = { type: 'cancel' }
      node.status.state = cancelState
      currentState.abortCtrl.abort()
      context.events.emit({ type: 'node', workTree, nodeId: node.id, oldState: currentState, newState: cancelState })
    } else if (
      (currentState.type === 'completed' || currentState.type === 'failed') &&
      !node.status.abortCtrl.signal.aborted
    ) {
      node.status.abortCtrl.abort()
    }
  }
}
