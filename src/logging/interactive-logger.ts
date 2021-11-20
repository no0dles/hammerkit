import { hideCursor, printWorkTreeResult, showCursor, writeWorkTreeStatus } from '../log'
import { clearScreenDown } from 'readline'
import { EventBus } from '../executer/event-bus'
import { SchedulerInitializeEvent, SchedulerTerminationEvent, SchedulerUpdateEvent } from '../executer/events'
import { SchedulerState } from '../executer/scheduler/scheduler-state'

export function interactiveLogger(eventBus: EventBus): void {
  let running = true
  let count = 0
  let schedulerState: SchedulerState | null = null

  const tickerFn = () => {
    if (!running) {
      return
    }

    if (!schedulerState) {
      return
    }

    count++
    writeWorkTreeStatus(schedulerState, count)
    if (running) {
      setTimeout(tickerFn, 100)
    }
  }

  eventBus.on<SchedulerInitializeEvent>('scheduler-initialize', (evt) => {
    hideCursor()
    tickerFn()
  })

  eventBus.on<SchedulerUpdateEvent>('scheduler-update', (evt) => {
    schedulerState = evt.state
    writeWorkTreeStatus(evt.state, count)
  })
  eventBus.on<SchedulerTerminationEvent>('scheduler-termination', async (evt) => {
    running = false
    clearScreenDown(process.stdout)
    await printWorkTreeResult(evt.state, true)
    showCursor()
  })
}
