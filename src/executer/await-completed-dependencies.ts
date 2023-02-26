import { isWorkTaskItem, WorkItem, WorkItemState } from '../planner/work-item'
import { WorkNode } from '../planner/work-node'
import { NodeCompletedState, NodeState } from './scheduler/node-state'
import { awaitState, isState } from './state-resolver'
import { ServiceRunningState, ServiceState } from './scheduler/service-state'
import { WorkService } from '../planner/work-service'

export async function awaitRequirement(
  svc: WorkItemState<WorkService, ServiceState>,
  abort: AbortSignal
): Promise<void> {
  await Promise.race(
    svc.requiredBy.map((required) => {
      if (isWorkTaskItem(required)) {
        return awaitState('await-requirement', required.state, (state) => state.type === 'ready', abort)
      } else {
        return awaitState('await-requirement', required.state, (state) => state.type === 'ready', abort)
      }
    })
  )
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
  work: WorkItem<WorkNode | WorkService>,
  deps: WorkItemState<WorkNode, NodeState>[],
  abort: AbortSignal
): Promise<void> {
  for (const dep of deps) {
    work.status.write('debug', `await completion of ${dep.name} with state ${dep.state.current.type}`)
    await awaitCompleted(work, dep, abort)
  }
}

export function awaitCompleted(
  work: WorkItem<WorkNode | WorkService>,
  dep: WorkItemState<WorkNode, NodeState>,
  abort: AbortSignal
): Promise<NodeCompletedState | null> {
  return isState('await-completed-' + work.name, dep.state, isCompleted, abort)
}

export function awaitRunningNeed(
  work: WorkItem<WorkNode | WorkService>,
  dep: WorkItemState<WorkService, ServiceState>,
  abort: AbortSignal
): Promise<ServiceRunningState | null> {
  return isState('await-running-need-' + work.name, dep.state, isRunning, abort)
}

export async function awaitRunningNeeds(
  work: WorkItem<WorkNode | WorkService>,
  needs: WorkItemState<WorkService, ServiceState>[],
  abort: AbortSignal
): Promise<void> {
  for (const need of needs) {
    work.status.write('debug', 'await need ' + need.name)
    await awaitRunningNeed(work, need, abort)
  }
}
function isCompleted(val: NodeState): val is NodeCompletedState {
  return val.type === 'completed'
}
function isRunning(val: ServiceState): val is ServiceRunningState {
  return val.type === 'running'
}
