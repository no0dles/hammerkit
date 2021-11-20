import {
  getNodeNameLengthForWorkTree,
  printWorkTreeResult,
  writeNodeLogToConsole,
  writeServiceLogToConsole,
} from '../log'
import { iterateWorkNodes } from '../planner/utils/plan-work-nodes'
import { EventBus } from '../executer/event-bus'
import { SchedulerInitializeEvent, SchedulerTerminationEvent } from '../executer/events'

export function liveLogger(eventBus: EventBus) {
  let maxNodeNameLength = 0

  eventBus.on<SchedulerInitializeEvent>('scheduler-initialize', (evt) => {
    maxNodeNameLength = getNodeNameLengthForWorkTree(evt.nodes, evt.services)

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

  eventBus.on<SchedulerTerminationEvent>('scheduler-termination', async (evt) => {
    await printWorkTreeResult(evt.state, false)
  })
}
