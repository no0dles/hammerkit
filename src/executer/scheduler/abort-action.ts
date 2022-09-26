import { SchedulerState } from './scheduler-state'

export function abort(state: SchedulerState): void {
  for (const node of Object.values(state.node)) {
    if (node.type === 'running') {
      node.abortController.abort()
    }
  }
  for (const service of Object.values(state.service)) {
    if (service.type === 'running') {
      service.abortController.abort()
    }
  }
}
