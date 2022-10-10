import {
  getNodeNameLengthForWorkTree,
  printWorkTreeResult,
  writeNodeLogToConsole,
  writeServiceLogToConsole,
} from '../log'
import { iterateWorkNodes } from '../planner/utils/plan-work-nodes'
import { SchedulerState } from '../executer/scheduler/scheduler-state'
import { Logger } from './log-mode'
import { SchedulerResult } from '../executer/scheduler/scheduler-result'

export function liveLogger(state: SchedulerState): Logger {
  const maxNodeNameLength = getNodeNameLengthForWorkTree(state.node, state.service)

  for (const node of iterateWorkNodes(state.node)) {
    node.node.console.on((log) => {
      writeNodeLogToConsole(node.node, log, maxNodeNameLength)
    })
  }

  for (const service of Object.values(state.service)) {
    service.service.console.on((log) => {
      writeServiceLogToConsole(service.service, log, maxNodeNameLength)
    })
  }

  return {
    async complete(evt: SchedulerResult) {
      await printWorkTreeResult(evt.state, !evt.success)
    },
  }
}
