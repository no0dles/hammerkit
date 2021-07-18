import { WorkTree } from '../planner/work-tree'
import { ExecutionContext } from '../run-arg'
import { iterateWorkNodes } from '../planner/utils/plan-work-nodes'
import {
  WorkNodeAbortedState,
  WorkNodeCancelState,
  WorkNodeCompletedState,
  WorkNodePendingState,
  WorkNodeRunningState,
  WorkNodeState,
} from '../planner/work-node-status'
import { Defer } from '../defer'

function getDuration(state: WorkNodeState): number {
  if (state.type === 'running') {
    return new Date().getTime() - state.started.getTime()
  }
  return 0
}

export function runNode(workTree: WorkTree, nodeId: string, context: ExecutionContext): Defer<void> {
  const runningState: WorkNodeRunningState = { type: 'running', started: new Date(), cancelDefer: new Defer<void>() }
  context.context.cancelDefer.promise.then(() => {
    if (!runningState.cancelDefer.isResolved) {
      runningState.cancelDefer.resolve()
    }
  })

  const currentState = workTree.nodes[nodeId].status.state
  workTree.nodes[nodeId].status.state = runningState
  context.runningNodes[nodeId] = workTree.nodes[nodeId]
  context.events.emit({ oldState: currentState, newState: runningState, nodeId, workTree })
  return runningState.cancelDefer
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
  if (!context.watch && !node.status.defer.isResolved) {
    node.status.defer.resolve()
  }
  delete context.runningNodes[node.id]

  for (const otherNode of iterateWorkNodes(workTree.nodes)) {
    const dependency = otherNode.status.pendingDependencies[node.id]
    if (dependency) {
      delete otherNode.status.pendingDependencies[node.id]
      otherNode.status.completedDependencies[node.id] = dependency
    }

    const completedDepNode = otherNode.status.completedDependencies[node.id]
    if (completedDepNode) {
      resetNode(workTree, otherNode.id, context)
    }
  }
  context.events.emit({ oldState: currentState, newState: completedState, nodeId, workTree })
}

export function failNode(workTree: WorkTree, nodeId: string, context: ExecutionContext, error: Error): void {
  const node = workTree.nodes[nodeId]
  delete context.runningNodes[nodeId]

  node.status.console.write('internal', 'error', error.message)

  const canceledExecution = context.context.cancelDefer.isResolved
  const currentState = node.status.state
  if (currentState.type === 'running') {
    const newState: WorkNodeState = canceledExecution
      ? { type: 'aborted' }
      : { type: 'failed', ended: new Date(), duration: getDuration(node.status.state), error }
    node.status.state = newState
    context.events.emit({ nodeId: node.id, workTree, newState, oldState: currentState })
  } else if (currentState.type === 'cancel') {
    const newState: WorkNodeState = canceledExecution ? { type: 'aborted' } : { type: 'pending' }
    node.status.state = newState
    context.events.emit({ nodeId: node.id, workTree, newState, oldState: currentState })
  }

  if (!canceledExecution && !context.watch) {
    cancelPendingNodes(workTree, nodeId, context)
  }

  if ((canceledExecution || !context.watch) && !node.status.defer.isResolved) {
    node.status.defer.resolve()
  }
}

export function resetNode(workTree: WorkTree, nodeId: string, context: ExecutionContext): void {
  const node = workTree.nodes[nodeId]

  const currentState = node.status.state
  if (currentState.type === 'running') {
    const cancelState: WorkNodeCancelState = { type: 'cancel' }
    node.status.state = cancelState
    currentState.cancelDefer.resolve()
    context.events.emit({ workTree, nodeId, oldState: currentState, newState: cancelState })
  } else if (currentState.type === 'completed' || currentState.type === 'failed') {
    const pendingState: WorkNodePendingState = { type: 'pending' }
    node.status.state = pendingState
    context.events.emit({ workTree, nodeId, oldState: currentState, newState: pendingState })
  }
}

function cancelPendingNodes(workTree: WorkTree, nodeId: string, context: ExecutionContext) {
  for (const node of iterateWorkNodes(workTree.nodes)) {
    if (!node.status.pendingDependencies[nodeId]) {
      continue
    }

    const currentState = node.status.state
    if (currentState.type === 'pending') {
      const cancelState: WorkNodeCancelState = { type: 'cancel' }
      node.status.state = cancelState
      context.events.emit({ workTree, nodeId, oldState: currentState, newState: cancelState })
      if (!context.watch) {
        node.status.defer.resolve()
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
      node.status.defer.resolve()
      context.events.emit({ nodeId: node.id, workTree, newState: abortState, oldState: currentState })
    } else if (currentState.type === 'running') {
      const cancelState: WorkNodeCancelState = { type: 'cancel' }
      node.status.state = cancelState
      currentState.cancelDefer.resolve()
      context.events.emit({ workTree, nodeId: node.id, oldState: currentState, newState: cancelState })
    } else if ((currentState.type === 'completed' || currentState.type === 'failed') && !node.status.defer.isResolved) {
      node.status.defer.resolve()
    }
  }
}
