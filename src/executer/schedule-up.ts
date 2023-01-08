import { ProcessManager } from './process-manager'
import { State } from './state'
import { Environment } from './environment'
import { scheduleNodes } from './schedule-nodes'
import { schedulePendingServices } from './schedule-pending-services'
import { scheduleReadyServices } from './schedule-ready-services'
import { startWatchProcesses } from '../start-watch-processes'
import { hasEndedService } from './has-ended-service'
import { getSchedulerUpResult } from './get-scheduler-up-result'

export async function scheduleUp(processManager: ProcessManager, state: State, environment: Environment) {
  if (state.current.watch && !state.current.daemon) {
    startWatchProcesses(state, processManager, environment)
  }

  state.on((currentState) => {
    if (!environment.abortCtrl.signal.aborted && hasEndedService(currentState)) {
      environment.abortCtrl.abort()
    }

    scheduleNodes(currentState, state, processManager, environment)
    schedulePendingServices(Object.values(currentState.service), state, processManager, environment, currentState)
    scheduleReadyServices(currentState, state, processManager, environment)
  })

  await processManager.onComplete()

  return getSchedulerUpResult(state.current)
}
