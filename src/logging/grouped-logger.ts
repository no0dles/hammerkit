import { getNodeNameLengthForSchedulerState, printWorkTreeResult, writeNodeLogToConsole } from '../log'
import { iterateWorkNodes, iterateWorkServices } from '../planner/utils/plan-work-nodes'
import { Logger } from './log-mode'
import { SchedulerResult } from '../executer/scheduler/scheduler-result'
import { Environment } from '../executer/environment'
import { WorkTree } from '../planner/work-tree'
import { State } from '../executer/state'

export function groupedLogger(state: State<WorkTree>, env: Environment): Logger {
  const maxNodeNameLength = getNodeNameLengthForSchedulerState(state.current)

  const completedNodes: string[] = []
  const completedServices: string[] = []

  state.on('log-status', (currentState) => {
    for (const node of iterateWorkNodes(currentState)) {
      if (completedNodes.indexOf(node.name) >= 0) {
        continue
      }

      if (
        node.state.current.type === 'crash' ||
        node.state.current.type === 'error' ||
        node.state.current.type === 'completed'
      ) {
        completedNodes.push(node.name)
        for (const log of node.status.read()) {
          writeNodeLogToConsole(env, log, maxNodeNameLength)
        }
      }
    }

    for (const service of iterateWorkServices(currentState)) {
      if (completedServices.indexOf(service.name) >= 0) {
        continue
      }

      if (service.state.current.type === 'end') {
        completedServices.push(service.name)
        for (const log of service.status.read()) {
          writeNodeLogToConsole(env, log, maxNodeNameLength)
        }
      }
    }
  })

  return {
    async complete(evt: SchedulerResult, env): Promise<void> {
      await printWorkTreeResult(evt.state, env)
    },
  }
}
