import { State } from './state'
import { isWorkTaskItem, WorkItem, WorkItemState } from '../planner/work-item'
import { WorkTask } from '../planner/work-task'
import { TaskCompletedState, TaskState } from './scheduler/task-state'
import { awaitState, isState } from './state-resolver'
import {
  ServiceCanceledState,
  ServiceEndState,
  ServiceErrorState,
  ServiceRunningState,
  ServiceState,
} from './scheduler/service-state'
import { WorkService } from '../planner/work-service'

// Resolve true once any requirer is `ready` (about to run). With
// `untilAllDone`, resolve false instead when every requirer has finished
// without needing the service — e.g. all of them were cache hits — so the
// service is never started.
export async function awaitRequirement(
  svc: WorkItemState<WorkService, ServiceState>,
  abort: AbortSignal,
  options: { untilAllDone: boolean } = { untilAllDone: false }
): Promise<boolean> {
  const ready = Promise.race(
    svc.requiredBy.map((required) =>
      awaitState('await-requirement', required.state as State<any>, (state) => state.type === 'ready', abort)
    )
  ).then(() => true)
  if (!options.untilAllDone) {
    return ready
  }
  const allDone = awaitNoRequirements(svc, abort).then(() => false)
  return Promise.race([ready, allDone])
}

// Resolve true once any dependent is `ready` — it missed the cache and is about
// to run, so it needs this task's outputs — and false once every dependent
// finished without needing it (all cache hits, or skipped themselves).
export async function awaitDependentNeed(
  dependents: WorkItemState<WorkTask, TaskState>[],
  abort: AbortSignal
): Promise<boolean> {
  const ready = Promise.race(
    dependents.map((dependent) => awaitState('await-dependent', dependent.state, (s) => s.type === 'ready', abort))
  ).then(() => true)
  const allDone = Promise.all(
    dependents.map((dependent) =>
      awaitState(
        'await-dependent-done',
        dependent.state,
        (s) => s.type === 'completed' || s.type === 'error' || s.type === 'crash' || s.type === 'canceled',
        abort
      )
    )
  ).then(() => false)
  return Promise.race([ready, allDone])
}

export async function awaitNoRequirements(svc: WorkItemState<WorkService, ServiceState>, abort: AbortSignal) {
  await Promise.all(
    svc.requiredBy.map((required) => {
      if (isWorkTaskItem(required)) {
        return awaitState(
          'await-no-requirement',
          required.state,
          (state) =>
            state.type === 'completed' || state.type === 'error' || state.type === 'crash' || state.type === 'canceled',
          abort
        )
      } else {
        return awaitState(
          'await-no-requirement',
          required.state,
          (state) => state.type === 'end' || state.type === 'error' || state.type === 'canceled',
          abort
        )
      }
    })
  )
}

export async function awaitCompletedDependencies(
  work: WorkItem<WorkTask | WorkService>,
  deps: WorkItemState<WorkTask, TaskState>[],
  abort: AbortSignal
): Promise<void> {
  for (const dep of deps) {
    work.status.write('debug', `await completion of ${dep.name} with state ${dep.state.current.type}`)
    await awaitCompleted(work, dep, abort)
  }
}

export function awaitCompleted(
  work: WorkItem<WorkTask | WorkService>,
  dep: WorkItemState<WorkTask, TaskState>,
  abort: AbortSignal
): Promise<TaskCompletedState | null> {
  return isState('await-completed-' + work.name, dep.state, isCompleted, abort)
}

// Wait for a needed service to run. A service that reaches a terminal state
// first (it failed to start or exited) can never become ready, so the waiting
// item fails instead of waiting forever.
export async function awaitRunningNeed(
  work: WorkItem<WorkTask | WorkService>,
  dep: WorkItemState<WorkService, ServiceState>,
  abort: AbortSignal
): Promise<ServiceRunningState | null> {
  const state = await isState('await-running-need-' + work.name, dep.state, isRunningOrDone, abort)
  if (state.type !== 'running') {
    throw new Error(`needed service ${dep.name} ${state.type === 'end' ? 'stopped' : 'failed'} before it was ready`)
  }
  return state
}

export async function awaitRunningNeeds(
  work: WorkItem<WorkTask | WorkService>,
  needs: WorkItemState<WorkService, ServiceState>[],
  abort: AbortSignal
): Promise<void> {
  for (const need of needs) {
    work.status.write('debug', 'await need ' + need.name)
    await awaitRunningNeed(work, need, abort)
  }
}
function isCompleted(val: TaskState): val is TaskCompletedState {
  return val.type === 'completed'
}
function isRunningOrDone(
  val: ServiceState
): val is ServiceRunningState | ServiceEndState | ServiceErrorState | ServiceCanceledState {
  return val.type === 'running' || val.type === 'end' || val.type === 'error' || val.type === 'canceled'
}
