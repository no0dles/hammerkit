import { getNodeNameLengthForWorkTree, printWorkTreeResult, writeNodeLogToConsole } from '../log'
import { SchedulerState } from '../executer/scheduler/scheduler-state'
import { Logger } from './log-mode'
import { SchedulerResult } from '../executer/scheduler/scheduler-result'
import { Environment } from '../executer/environment'
import { ReadonlyState } from '../executer/readonly-state'

export function liveLogger(state: ReadonlyState<SchedulerState>, env: Environment): Logger {
  const maxNodeNameLength = getNodeNameLengthForWorkTree(state.current.node, state.current.service)

  env.status.on((log) => {
    writeNodeLogToConsole(env, log, maxNodeNameLength)
  })

  return {
    async complete(evt: SchedulerResult, env) {
      await printWorkTreeResult(evt.state, env)
    },
  }
}
