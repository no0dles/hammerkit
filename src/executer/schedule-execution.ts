import { Environment } from './environment'
import { SchedulerResult } from './scheduler/scheduler-result'
import { State } from './state'
import { ProcessManager } from './process-manager'
import { startWatchProcesses } from '../start-watch-processes'
import { scheduleReadyServices } from './schedule-ready-services'
import { scheduleNodes } from './schedule-nodes'
import { unscheduleServices } from './unschedule-services'
import { getSchedulerExecuteResult } from './get-scheduler-execute-result'

export async function scheduleExecution(
  processManager: ProcessManager,
  state: State,
  environment: Environment
): Promise<SchedulerResult> {
  if (state.current.watch) {
    startWatchProcesses(state, processManager, environment)
  }

  state.on((currentState) => {
    scheduleNodes(currentState, state, processManager, environment)
    scheduleReadyServices(currentState, state, processManager, environment)
    unscheduleServices(currentState, state, processManager, environment, false)
  })

  await processManager.onComplete()

  return getSchedulerExecuteResult(state.current)
}
