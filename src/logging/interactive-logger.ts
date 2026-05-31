import { hideCursor, printWorkTreeResult, showCursor, writeWorkTreeStatus } from '../log'
import { clearScreenDown } from 'readline'
import { Logger } from './log-mode'
import { SchedulerResult } from '../executer/scheduler/scheduler-result'
import { Environment } from '../executer/environment'
import { WorkTree } from '../planner/work-tree'
import { State } from '../executer/state'

export function interactiveLogger(state: State<WorkTree>, env: Environment): Logger {
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

  hideCursor(env)
  tickerFn()

  state.on('log-status', (currentState) => {
    writeWorkTreeStatus(currentState, env, count)
  })

  return {
    async complete(evt: SchedulerResult, env): Promise<void> {
      running = false
      clearScreenDown(env.stdout)
      await printWorkTreeResult(evt.state, env)
      showCursor(env)
    },
  }
}
