import { getNodeNameLengthForWorkTree, printWorkTreeResult, writeNodeLogToConsole } from '../log'
import { iterateWorkNodes, iterateWorkServices } from '../planner/utils/plan-work-nodes'
import { SchedulerState } from '../executer/scheduler/scheduler-state'
import { Logger } from './log-mode'
import { SchedulerResult } from '../executer/scheduler/scheduler-result'
import { Environment } from '../executer/environment'
import { ReadonlyState } from '../executer/readonly-state'

export function groupedLogger(state: ReadonlyState<SchedulerState>, env: Environment): Logger {
  const maxNodeNameLength = getNodeNameLengthForWorkTree(state.current.node, state.current.service)

  const completedNodes: string[] = []
  const completedServices: string[] = []

  state.on((currentState) => {
    for (const node of iterateWorkNodes(currentState.node)) {
      if (completedNodes.indexOf(node.node.id) >= 0) {
        continue
      }

      if (node.type === 'crash' || node.type === 'error' || node.type === 'completed') {
        completedNodes.push(node.node.id)
        for (const log of env.status.task(node.node).read()) {
          writeNodeLogToConsole(env, log, maxNodeNameLength)
        }
      }
    }

    for (const service of iterateWorkServices(currentState.service)) {
      if (completedServices.indexOf(service.service.id) >= 0) {
        continue
      }

      if (service.type === 'end') {
        completedServices.push(service.service.id)
        for (const log of env.status.service(service.service).read()) {
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
