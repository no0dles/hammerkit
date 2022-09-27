import { Logger, LogMode } from '../logging/log-mode'
import { SchedulerState } from '../executer/scheduler/scheduler-state'
import { UpdateBus } from '../executer/emitter'
import { HammerkitEvent } from '../executer/events'
import { groupedLogger } from '../logging/grouped-logger'
import { liveLogger } from '../logging/live-logger'
import { interactiveLogger } from '../logging/interactive-logger'
import { failNever } from '../utils/fail-never'

export function getLogger(mode: LogMode, state: SchedulerState, bus: UpdateBus<HammerkitEvent>): Logger {
  if (mode === 'grouped') {
    return groupedLogger(state, bus)
  } else if (mode === 'live') {
    return liveLogger(state)
  } else if (mode === 'interactive') {
    return interactiveLogger(state, bus)
  } else {
    failNever(mode, 'unknown log mode')
  }
}
