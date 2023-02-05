import { StatusScopedConsole } from './work-node-status'
import { ContainerWorkService, KubernetesWorkService, WorkService } from './work-service'
import { ContainerWorkNode, LocalWorkNode, WorkNode } from './work-node'

export interface WorkItem<T> {
  id: string
  name: string
  status: StatusScopedConsole
  data: T
  needs: WorkItemNeed[]
  deps: WorkItem<WorkNode>[]
}

export const isContainerWorkItem = (
  val: WorkItem<WorkService | WorkNode>
): val is WorkItem<ContainerWorkService | ContainerWorkNode> =>
  val.data.type === 'container-service' || val.data.type === 'container-task'

export const isContainerWorkTaskItem = (val: WorkItem<WorkNode>): val is WorkItem<ContainerWorkNode> =>
  val.data.type === 'container-task'
export const isLocalWorkTaskItem = (val: WorkItem<WorkNode>): val is WorkItem<LocalWorkNode> =>
  val.data.type === 'local-task'
export const isContainerWorkServiceItem = (val: WorkItem<WorkService>): val is WorkItem<ContainerWorkService> =>
  val.data.type === 'container-service'
export const isKubernetesWorkServiceItem = (val: WorkItem<WorkService>): val is WorkItem<KubernetesWorkService> =>
  val.data.type === 'kubernetes-service'

export interface WorkItemNeed {
  name: string
  service: WorkItem<WorkService>
}
