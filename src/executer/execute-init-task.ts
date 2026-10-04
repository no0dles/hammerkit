import { WorkItemState } from '../planner/work-item'
import { WorkTask } from '../planner/work-task'
import { WorkService, WorkServiceInit } from '../planner/work-service'
import { TaskState } from './scheduler/task-state'
import { ServiceState } from './scheduler/service-state'
import { Environment } from './environment'
import { CliExecOptions } from '../cli'
import { awaitState, isState } from './state-resolver'
import { executeWorkTask } from './execute-work-task'
import { AbortError } from './abort'
import { listenOnAbort } from '../utils/abort-event'

const isTerminalService = (state: ServiceState) =>
  state.type === 'end' || state.type === 'error' || state.type === 'canceled'

export const isTerminalTask = (state: TaskState) =>
  state.type === 'completed' || state.type === 'error' || state.type === 'crash' || state.type === 'canceled'

// The init task of a service runs each time the service passed its healthcheck
// in this run, never on its own: a service left running by an earlier `up` ran
// its init when it started, so the init is skipped unless it was asked for by
// name. A failing init fails the run like any failing task.
export async function executeInitTask(
  work: WorkItemState<WorkTask, TaskState>,
  init: WorkServiceInit,
  service: WorkItemState<WorkService, ServiceState> | null,
  requested: boolean,
  environment: Environment,
  options: CliExecOptions
) {
  if (!service || service.state.current.type === 'running') {
    if (service && requested) {
      await executeWorkTask(work, environment, options)
      return
    }
    skip(work, `${work.name} skipped, the service it initializes does not start in this run`)
    return
  }
  if (requested) {
    // asked for by name, the init is what the service starts for
    work.state.set({ type: 'ready', stateKey: '', started: new Date() })
  }

  try {
    do {
      const view = await isState(
        'await-init-' + work.name,
        init.state,
        (state): state is ServiceState => state.type === 'running' || isTerminalService(state),
        environment.abortCtrl.signal
      )
      if (view.type !== 'running') {
        if (!isTerminalTask(work.state.current)) {
          skip(work, `${work.name} skipped, ${service.name} did not start`)
        }
        return
      }

      await runOnce(work, environment, options)
      settleService(service, work, view)

      if (!options.watch) {
        return
      }
      await awaitState(
        'await-init-restart-' + work.name,
        init.state,
        (state) => state.type !== 'running',
        environment.abortCtrl.signal
      )
    } while (!environment.abortCtrl.signal.aborted)
  } catch (e) {
    if (!(e instanceof AbortError)) {
      throw e
    }
    if (!isTerminalTask(work.state.current)) {
      work.state.set({ type: 'canceled', stateKey: null })
    }
  }
}

// Only now does the service run for everything else needing it.
function settleService(
  service: WorkItemState<WorkService, ServiceState>,
  work: WorkItemState<WorkTask, TaskState>,
  view: ServiceState
) {
  const result = work.state.current
  if (result.type === 'completed') {
    service.state.set(view)
    return
  }
  service.state.set({
    type: 'error',
    stateKey: null,
    errorMessage: `init ${work.name} did not succeed (${result.type})`,
  })
}

// One run of the init as a plain task. It aborts its own run when it fails;
// the whole run stops only outside watch mode, as for a failing service.
async function runOnce(work: WorkItemState<WorkTask, TaskState>, environment: Environment, options: CliExecOptions) {
  const abortCtrl = new AbortController()
  const abortListener = listenOnAbort(environment.abortCtrl.signal, () => abortCtrl.abort())
  try {
    await executeWorkTask(work, { ...environment, abortCtrl }, { ...options, watch: false })
  } finally {
    abortListener.close()
  }
  const result = work.state.current.type
  if ((result === 'error' || result === 'crash') && !options.watch) {
    environment.abortCtrl.abort()
  }
}

function skip(work: WorkItemState<WorkTask, TaskState>, message: string) {
  work.status.write('debug', message)
  work.state.set({ type: 'completed', cached: false, skipped: true, duration: 0, stateKey: '' })
}

// The service a task is the init of: the task needs it through the view the
// planner gave it, which shares the service's data.
export function findInitOf(
  task: WorkItemState<WorkTask, TaskState>
): { serviceName: string; init: WorkServiceInit } | null {
  for (const need of task.needs) {
    const data = need.service.data
    if (data.type === 'container-service' && data.init && data.init.task === task) {
      return { serviceName: need.service.name, init: data.init }
    }
  }
  return null
}
