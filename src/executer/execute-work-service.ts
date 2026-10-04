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
import { WorkServiceInit } from '../planner/work-service'
import { State } from './state'

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

      const init = getServiceInit(work)
      await work.runtime.execute(environment, {
        cache: cacheState,
        abort,
        state: init ? gateOnInit(work, init) : work.state,
        stateKey: cacheState.stateKey,
        daemon: options.daemon,
        publishPorts:
          options.type === 'up' || work.requiredBy.some(isLocalTaskItem) || (!!init && isLocalTaskItem(init.task)),
        // an init needs a healthy service, so a service with one is always awaited
        waitForReady: options.wait === 'ready' || work.requiredBy.length > 0 || !!init,
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

function getServiceInit(work: WorkItemState<WorkService, ServiceState>): WorkServiceInit | null {
  return work.data.type === 'container-service' ? work.data.init : null
}

// With an init, the runtime's `running` (healthcheck passed) first reaches only
// the init task's view of the service; executeInitTask runs the init and then
// sets the service running, or failed.
function gateOnInit(work: WorkItemState<WorkService, ServiceState>, init: WorkServiceInit): State<ServiceState> {
  const gate = new State<ServiceState>(work.state.current)
  gate.on('init-gate', (state) => {
    if (state.type !== 'running') {
      if (work.state.current.type !== 'error') {
        work.state.set(state)
      }
      return
    }
    work.status.write('info', `${work.name} is healthy, run its init ${init.task.name}`)
    init.state.set(state)
  })
  return gate
}

function isLocalTaskItem(item: WorkItemState<WorkTask, TaskState> | WorkItemState<WorkService, ServiceState>): boolean {
  return isWorkTaskItem(item) && isLocalWorkTaskItem(item)
}
