import {
  getNodeNameLengthForWorkTree,
  printWorkTreeResult,
  writeNodeLogToConsole,
  writeServiceLogToConsole,
} from '../log'
import { iterateWorkNodes } from '../planner/utils/plan-work-nodes'
import { HammerkitEvent, SchedulerInitializeEvent, SchedulerTerminationEvent } from '../executer/events'
import { UpdateBus } from '../executer/emitter'
import { SchedulerState } from '../executer/scheduler/scheduler-state'
import { Logger } from './log-mode'

export function liveLogger(state: SchedulerState, eventBus: UpdateBus<HammerkitEvent>): Logger {
  const maxNodeNameLength = getNodeNameLengthForWorkTree(state.node, state.service)

  eventBus.on<SchedulerInitializeEvent>('scheduler-initialize', (evt) => {
    for (const node of iterateWorkNodes(evt.nodes)) {
      node.console.on((log) => {
        writeNodeLogToConsole(node, log, maxNodeNameLength)
      })
    }

    for (const service of Object.values(evt.services)) {
      service.console.on((log) => {
        writeServiceLogToConsole(service, log, maxNodeNameLength)
      })
    }
  })

  return {
    async complete(evt: SchedulerTerminationEvent) {
      await printWorkTreeResult(evt.state, false)
    },
  }
}
