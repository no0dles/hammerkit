import { hideCursor, printWorkTreeResult, showCursor, writeWorkTreeStatus } from '../log'
import { clearScreenDown } from 'readline'
import { HammerkitEvent, SchedulerUpdateEvent } from '../executer/events'
import { SchedulerState } from '../executer/scheduler/scheduler-state'
import { UpdateBus } from '../executer/emitter'
import { Logger } from './log-mode'
import { SchedulerResult } from '../executer/scheduler/scheduler-result'

export function interactiveLogger(state: SchedulerState, eventBus: UpdateBus<HammerkitEvent>): Logger {
  let running = true
  let count = 0
  let schedulerState: SchedulerState = state

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

  hideCursor()
  tickerFn()

  eventBus.on<SchedulerUpdateEvent>('scheduler-update', (evt) => {
    schedulerState = evt.state
    writeWorkTreeStatus(evt.state, count)
  })

  return {
    async complete(evt: SchedulerResult): Promise<void> {
      running = false
      clearScreenDown(process.stdout)
      await printWorkTreeResult(evt.state, true)
      showCursor()
    },
  }
}
