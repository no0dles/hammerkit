import { StatusScopedConsole } from './work-item-status'
import { ContainerWorkService, KubernetesWorkService, WorkService } from './work-service'
import { ContainerWorkTask, LocalWorkTask, WorkTask } from './work-task'
import { TaskState } from '../executer/scheduler/task-state'
import { ServiceState } from '../executer/scheduler/service-state'
import { State } from '../executer/state'
import { WorkRuntime } from '../runtime/runtime'

export interface WorkItemState<T extends WorkService | WorkTask, S> extends WorkItem<T> {
  state: State<S>
  runtime: WorkRuntime<S>
}

export interface WorkItem<T extends WorkService | WorkTask> {
  id: () => string
  name: string
  status: StatusScopedConsole
  data: T
  needs: WorkItemNeed[]
  deps: WorkItemState<WorkTask, TaskState>[]
  requiredBy: (WorkItemState<WorkTask, TaskState> | WorkItemState<WorkService, ServiceState>)[]
}

export const isContainerWorkItem = (
  val: WorkItem<WorkService | WorkTask>
): val is WorkItem<ContainerWorkService | ContainerWorkTask> =>
  val.data.type === 'container-service' || val.data.type === 'container-task'

export const isWorkTaskItem = (val: WorkItem<WorkService | WorkTask>): val is WorkItem<WorkTask> =>
  val.data.type === 'local-task' || val.data.type === 'container-task'

export const isContainerWorkTaskItem = (val: WorkItem<WorkTask>): val is WorkItem<ContainerWorkTask> =>
  val.data.type === 'container-task'
export const isLocalWorkTaskItem = (val: WorkItem<WorkTask>): val is WorkItem<LocalWorkTask> =>
  val.data.type === 'local-task'
export const isContainerWorkServiceItem = (val: WorkItem<WorkService>): val is WorkItem<ContainerWorkService> =>
  val.data.type === 'container-service'
export const isKubernetesWorkServiceItem = (val: WorkItem<WorkService>): val is WorkItem<KubernetesWorkService> =>
  val.data.type === 'kubernetes-service'

export interface WorkItemNeed {
  name: string
  service: WorkItemState<WorkService, ServiceState>
}
