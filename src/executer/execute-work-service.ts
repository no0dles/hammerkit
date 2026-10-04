import { isLocalWorkTaskItem, isWorkTaskItem, WorkItemState } from '../planner/work-item'
import { WorkTask } from '../planner/work-task'
import { TaskState } from './scheduler/task-state'
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
        // ended, so the services it needs see it done too; left pending they
        // would wait for it forever and the run would never finish
        work.state.set({
          type: 'end',
          reason: 'not-started',
          stateKey: null,
        })
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
        // rejects when the run is aborted; unhandled, that rejection would
        // crash hammerkit before the service container is removed
        awaitNoRequirements(work, abort).then(
          () => {
            stop()
          },
          () => {
            // aborted: the service is stopping anyway
          }
        )
      }

      await work.runtime.execute(environment, {
        cache: cacheState,
        abort,
        state: work.state,
        stateKey: cacheState.stateKey,
        daemon: options.daemon,
        publishPorts: options.type === 'up' || work.requiredBy.some(isLocalTaskItem),
        waitForReady: options.wait === 'ready' || work.requiredBy.length > 0,
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

function isLocalTaskItem(item: WorkItemState<WorkTask, TaskState> | WorkItemState<WorkService, ServiceState>): boolean {
  return isWorkTaskItem(item) && isLocalWorkTaskItem(item)
}
