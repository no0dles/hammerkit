import { checkCacheState } from './scheduler/enqueue-next'
import { getDuration } from './states'
import { WorkNode } from '../planner/work-node'
import { Environment } from './environment'
import { State } from './state'

export async function startNode(
  node: WorkNode,
  started: Date,
  state: State,
  abort: AbortController,
  environment: Environment
): Promise<boolean> {
  const cacheState = await checkCacheState(node, state.current.cacheMethod, environment)
  if (!cacheState.changed) {
    state.patchNode({
      type: 'completed',
      node: node,
      cached: true,
      duration: getDuration(started),
    })
    return true
  } else {
    state.patchNode({
      type: 'running',
      node: node,
      stateKey: cacheState.stateKey,
      started,
      abortController: abort,
    })
    return false
  }
}
