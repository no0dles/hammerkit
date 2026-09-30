import { WorkItemState } from '../planner/work-item'
import { WorkService } from '../planner/work-service'
import { ServiceState } from './scheduler/service-state'
import { Environment } from './environment'
import { CliExecOptions } from '../cli'
import {
  awaitCompletedDependencies,
  awaitNoRequirements,
  awaitRequirement,
  awaitRunningNeeds,
} from './await-completed-dependencies'
import { AbortError } from './abort'
import { getErrorMessage } from '../log'
import { watchLoop } from './watch-loop'

export async function stopService(work: WorkItemState<WorkService, ServiceState>) {
  if (work.state.current.type === 'running') {
    await work.runtime.stop()
  }
}

export async function executeWorkService(
  work: WorkItemState<WorkService, ServiceState>,
  environment: Environment,
  options: CliExecOptions
) {
  try {
    if (options.type === 'execute') {
      const required = await awaitRequirement(work, environment.abortCtrl.signal, { untilAllDone: !options.watch })
      if (!required) {
        work.status.write('debug', `${work.name} not started, no task needing it had to run`)
        return
      }
    }

    work.state.set({
      type: 'starting',
      stateKey: null,
    })

    await watchLoop(work, environment, options, async (cacheState, abort, stop) => {
      await awaitCompletedDependencies(work, work.deps, abort)

      work.state.set({
        type: 'ready',
        stateKey: cacheState.stateKey,
      })

      await awaitRunningNeeds(
        work,
        work.needs.map((n) => n.service),
        abort
      )

      if (options.type === 'execute') {
        awaitNoRequirements(work, abort).then(() => {
          stop()
        })
      }

      await work.runtime.execute(environment, {
        cache: cacheState,
        abort,
        state: work.state,
        stateKey: cacheState.stateKey,
        daemon: options.daemon,
      })
    })
  } catch (e) {
    if (e instanceof AbortError) {
      work.state.set({
        type: 'canceled',
        stateKey: null,
      })
    } else {
      work.state.set({
        type: 'error',
        errorMessage: getErrorMessage(e),
        stateKey: null,
      })
      // fail fast like a failing task: whatever needs this service can never
      // run, and would otherwise wait for it forever
      if (!options.watch) {
        environment.abortCtrl.abort()
      }
    }
  }
}
