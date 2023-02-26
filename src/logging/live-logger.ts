import { getNodeNameLengthForSchedulerState, printWorkTreeResult, writeNodeLogToConsole } from '../log'
import { Logger } from './log-mode'
import { SchedulerResult } from '../executer/scheduler/scheduler-result'
import { Environment } from '../executer/environment'
import { WorkTree } from '../planner/work-tree'
import { State } from '../executer/state'

export function liveLogger(state: State<WorkTree>, env: Environment): Logger {
  const maxNodeNameLength = getNodeNameLengthForSchedulerState(state.current)

  env.status.on((log) => {
    writeNodeLogToConsole(env, log, maxNodeNameLength)
  })

  return {
    async complete(evt: SchedulerResult, env) {
      await printWorkTreeResult(evt.state, env)
    },
  }
}
