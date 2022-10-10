import { HammerkitEvent } from './events'
import { SchedulerState } from './scheduler/scheduler-state'
import { UpdateEmitter } from './emitter'
import { Environment } from './environment'
import { SchedulerResult } from './scheduler/scheduler-result'
import { enqueuePending } from './enqueue-pending'
import { changeState } from './update-state'

export async function schedule(
  emitter: UpdateEmitter<HammerkitEvent>,
  initialState: SchedulerState,
  environment: Environment
): Promise<SchedulerResult> {
  let current: HammerkitEvent | null = null
  let state = initialState

  do {
    state = await enqueuePending(state, environment, emitter)

    current = await emitter.next()
    if (current) {
      state = changeState(state, emitter, current)
    }
  } while (hasPending(state))

  const success = !Object.values(state.node).some((n) => n.type !== 'completed')

  return {
    state,
    success,
  }
}

function hasPending(state: SchedulerState) {
  return Object.values(state.node).some((n) => n.type === 'running' || n.type === 'pending')
}
