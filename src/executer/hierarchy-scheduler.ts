import { HammerkitEvent } from './events'
import { SchedulerState } from './scheduler/scheduler-state'
import { UpdateEmitter } from './emitter'
import { Environment } from './environment'
import { SchedulerResult } from './scheduler/scheduler-result'
import { enqueuePending } from './enqueue-pending'
import { updateState } from './update-state'

export async function schedule(
  emitter: UpdateEmitter<HammerkitEvent>,
  initialState: SchedulerState,
  environment: Environment
): Promise<SchedulerResult> {
  let current: HammerkitEvent | null = null
  let state = initialState

  do {
    await enqueuePending(state, environment, emitter)

    current = await emitter.next()

    if (current) {
      state = updateState(state, current)
    }
  } while (current)

  const success = !Object.values(state.node).some((n) => n.type !== 'completed')

  return {
    state,
    success,
  }
}
