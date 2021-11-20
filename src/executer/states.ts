import { NodeState } from './scheduler/node-state'

export function getDuration(state: NodeState): number {
  if (state.type === 'running') {
    return new Date().getTime() - state.started.getTime()
  }
  return 0
}
