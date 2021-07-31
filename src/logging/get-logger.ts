import { LogMode } from './log-mode'
import { LogStrategy } from './log-strategy'
import { failNever } from '../utils/fail-never'
import { liveLogger } from './live-logger'
import { interactiveLogger } from './interactive-logger'
import { groupedLogger } from './grouped-logger'

export function getLogger(mode: LogMode): LogStrategy {
  if (mode === 'interactive') {
    return interactiveLogger()
  } else if (mode === 'live') {
    return liveLogger()
  } else if (mode === 'grouped') {
    return groupedLogger()
  } else {
    failNever(`Unknown logging mode ${mode}`)
  }
}
