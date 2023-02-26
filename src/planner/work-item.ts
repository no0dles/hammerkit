import { StatusScopedConsole } from './work-node-status'
import { ContainerWorkService, KubernetesWorkService, WorkService } from './work-service'
import { ContainerWorkNode, LocalWorkNode, WorkNode } from './work-node'
import { NodeState } from '../executer/scheduler/node-state'
import { ServiceState } from '../executer/scheduler/service-state'
import { State } from '../executer/state'

export interface WorkItemState<T, S> extends WorkItem<T> {
  state: State<S>
}

export interface WorkItem<T> {
  id: () => string
  name: string
  status: StatusScopedConsole
  data: T
  needs: WorkItemNeed[]
  deps: WorkItemState<WorkNode, NodeState>[]
  requiredBy: (WorkItemState<WorkNode, NodeState> | WorkItemState<WorkService, ServiceState>)[]
}

export const isContainerWorkItem = (
  val: WorkItem<WorkService | WorkNode>
): val is WorkItem<ContainerWorkService | ContainerWorkNode> =>
  val.data.type === 'container-service' || val.data.type === 'container-task'

export const isWorkTaskItem = (val: WorkItem<WorkService | WorkNode>): val is WorkItem<WorkNode> =>
  val.data.type === 'local-task' || val.data.type === 'container-task'

export const isContainerWorkTaskItem = (val: WorkItem<WorkNode>): val is WorkItem<ContainerWorkNode> =>
  val.data.type === 'container-task'
export const isLocalWorkTaskItem = (val: WorkItem<WorkNode>): val is WorkItem<LocalWorkNode> =>
  val.data.type === 'local-task'
export const isContainerWorkServiceItem = (
  val: WorkItem<WorkService>
): val is WorkItemState<ContainerWorkService, ServiceState> => val.data.type === 'container-service'
export const isKubernetesWorkServiceItem = (val: WorkItem<WorkService>): val is WorkItem<KubernetesWorkService> =>
  val.data.type === 'kubernetes-service'

export interface WorkItemNeed {
  name: string
  service: WorkItemState<WorkService, ServiceState>
}
