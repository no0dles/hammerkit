import { Logger, LogMode } from '../logging/log-mode'
import { SchedulerState } from '../executer/scheduler/scheduler-state'
import { groupedLogger } from '../logging/grouped-logger'
import { liveLogger } from '../logging/live-logger'
import { interactiveLogger } from '../logging/interactive-logger'
import { failNever } from '../utils/fail-never'
import { Environment } from '../executer/environment'
import { ReadonlyState } from '../executer/readonly-state'

export function getLogger(mode: LogMode, state: ReadonlyState<SchedulerState>, env: Environment): Logger {
  if (mode === 'grouped') {
    return groupedLogger(state, env)
  } else if (mode === 'live') {
    return liveLogger(state, env)
  } else if (mode === 'interactive') {
    return interactiveLogger(state, env)
  } else {
    failNever(mode, 'unknown log mode')
  }
}
