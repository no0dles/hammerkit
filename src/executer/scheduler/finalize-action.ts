import { SchedulerState } from './scheduler-state'
import { EventBus } from '../event-bus'

export async function finalize(state: SchedulerState, eventBus: EventBus) {
  const hasRunningNodes = Object.values(state.node).some((n) => n.type === 'running')
  if (hasRunningNodes) {
    return
  }

  const hasRunningServices = Object.values(state.service).some((s) => s.type === 'running' || s.type === 'ready')
  if (hasRunningServices) {
    return
  }

  const success = !Object.values(state.node).some((n) => n.type !== 'completed')

  await eventBus.emit({
    type: 'scheduler-termination',
    state,
    success,
  })
}
