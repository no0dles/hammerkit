import {
  getNodeNameLengthForWorkTree,
  printWorkTreeResult,
  writeNodeLogToConsole,
  writeServiceLogToConsole,
} from '../log'
import { HammerkitEvent, SchedulerUpdateEvent } from '../executer/events'
import { iterateWorkNodes, iterateWorkServices } from '../planner/utils/plan-work-nodes'
import { UpdateBus } from '../executer/emitter'
import { SchedulerState } from '../executer/scheduler/scheduler-state'
import { Logger } from './log-mode'
import { SchedulerResult } from '../executer/scheduler/scheduler-result'

export function groupedLogger(state: SchedulerState, eventBus: UpdateBus<HammerkitEvent>): Logger {
  const maxNodeNameLength = getNodeNameLengthForWorkTree(state.node, state.service)

  const completedNodes: string[] = []
  const completedServices: string[] = []

  eventBus.on<SchedulerUpdateEvent>('scheduler-update', async (evt) => {
    for (const node of iterateWorkNodes(evt.state.node)) {
      if (completedNodes.indexOf(node.node.id) >= 0) {
        continue
      }

      if (node.type === 'crash' || node.type === 'error' || node.type === 'completed') {
        completedNodes.push(node.node.id)
        for (const log of await node.node.console.read()) {
          writeNodeLogToConsole(node.node, log, maxNodeNameLength)
        }
      }
    }

    for (const service of iterateWorkServices(evt.state.service)) {
      if (completedServices.indexOf(service.service.id) >= 0) {
        continue
      }

      if (service.type === 'end') {
        completedServices.push(service.service.id)
        for (const log of await service.service.console.read()) {
          writeServiceLogToConsole(service.service, log, maxNodeNameLength)
        }
      }
    }
  })

  return {
    async complete(evt: SchedulerResult): Promise<void> {
      await printWorkTreeResult(evt.state, false)
    },
  }
}
