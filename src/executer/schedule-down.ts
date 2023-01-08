import { ProcessManager } from './process-manager'
import { State } from './state'
import { Environment } from './environment'
import { SchedulerResult } from './scheduler/scheduler-result'
import { unscheduleServices } from './unschedule-services'
import { areAllServicesDown } from './are-all-services-down'
import { getSchedulerDownResult } from './get-scheduler-down-result'

export async function scheduleDown(processManager: ProcessManager, state: State, environment: Environment) {
  return new Promise<SchedulerResult>((resolve) => {
    state.on((currentState) => {
      unscheduleServices(currentState, state, processManager, environment, true)

      if (areAllServicesDown(currentState)) {
        resolve(getSchedulerDownResult(currentState))
      }
    })
  })
}
