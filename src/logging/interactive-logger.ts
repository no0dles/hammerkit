import { hideCursor, printWorkTreeResult, showCursor, writeWorkTreeStatus } from '../log'
import { clearScreenDown } from 'readline'
import { SchedulerState } from '../executer/scheduler/scheduler-state'
import { Logger } from './log-mode'
import { SchedulerResult } from '../executer/scheduler/scheduler-result'
import { Environment } from '../executer/environment'
import { ReadonlyState } from '../executer/readonly-state'

export function interactiveLogger(state: ReadonlyState<SchedulerState>, env: Environment): Logger {
  let running = true
  let count = 0

  const tickerFn = () => {
    if (!running) {
      return
    }

    count++
    writeWorkTreeStatus(state.current, env, count)
    if (running) {
      setTimeout(tickerFn, 100)
    }
  }

  hideCursor()
  tickerFn()

  state.on((currentState) => {
    writeWorkTreeStatus(currentState, env, count)
  })

  return {
    async complete(evt: SchedulerResult, env): Promise<void> {
      running = false
      clearScreenDown(process.stdout)
      await printWorkTreeResult(evt.state, env)
      showCursor()
    },
  }
}
