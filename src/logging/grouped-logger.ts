import {
  getNodeNameLengthForWorkTree,
  printWorkTreeResult,
  writeNodeLogToConsole,
  writeServiceLogToConsole,
} from '../log'
import { EventBus } from '../executer/event-bus'
import { SchedulerInitializeEvent, SchedulerTerminationEvent, SchedulerUpdateEvent } from '../executer/events'
import { iterateWorkNodes, iterateWorkServices } from '../planner/utils/plan-work-nodes'

export function groupedLogger(eventBus: EventBus): void {
  let maxNodeNameLength = 0
  const completedNodes: string[] = []
  const completedServices: string[] = []

  eventBus.on<SchedulerInitializeEvent>('scheduler-initialize', (evt) => {
    maxNodeNameLength = getNodeNameLengthForWorkTree(evt.nodes, evt.services)
  })

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
  eventBus.on<SchedulerTerminationEvent>('scheduler-termination', async (evt) => {
    await printWorkTreeResult(evt.state, false)
  })
}
