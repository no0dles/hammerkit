import { getWorkItemMaxLength, printWorkTreeResult, writeWorkItemLogToConsole } from '../log'
import { iterateWorkTasks, iterateWorkServices } from '../planner/utils/plan-work-tasks'
import { Logger } from './log-mode'
import { SchedulerResult } from '../executer/scheduler/scheduler-result'
import { Environment } from '../executer/environment'
import { WorkTree } from '../planner/work-tree'
import { State } from '../executer/state'

export function groupedLogger(state: State<WorkTree>, env: Environment): Logger {
  const maxNodeNameLength = getWorkItemMaxLength(state.current)

  const completedNodes: string[] = []
  const completedServices: string[] = []

  state.on('log-status', (currentState) => {
    for (const task of iterateWorkTasks(currentState)) {
      if (completedNodes.indexOf(task.name) >= 0) {
        continue
      }

      if (
        task.state.current.type === 'crash' ||
        task.state.current.type === 'error' ||
        task.state.current.type === 'completed'
      ) {
        completedNodes.push(task.name)
        for (const log of task.status.read()) {
          writeWorkItemLogToConsole(env, log, maxNodeNameLength)
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
          writeWorkItemLogToConsole(env, log, maxNodeNameLength)
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
