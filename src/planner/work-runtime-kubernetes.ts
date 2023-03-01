import { ExecuteOptions, WorkRuntime } from '../runtime/runtime'
import { ContainerWorkService, KubernetesWorkService } from './work-service'
import { ServiceState } from '../executer/scheduler/service-state'
import { TaskState } from '../executer/scheduler/task-state'
import { ContainerWorkTask } from './work-task'
import { WorkItem } from './work-item'
import { State } from '../executer/state'
import { Environment } from '../executer/environment'
import { kubernetesService } from '../executer/kubernetes-service'

export function kubernetesTaskRuntime(service: WorkItem<ContainerWorkTask>): WorkRuntime<TaskState> {
  return {
    initialize(item: State<TaskState>): Promise<void> {
      throw new Error('not implemented')
    },
    restore(environment: Environment, path: string): Promise<void> {
      throw new Error('not implemented')
    },
    archive(environment: Environment, path: string): Promise<void> {
      throw new Error('not implemented')
    },
    execute(environment: Environment, options: ExecuteOptions<TaskState>): Promise<void> {
      throw new Error('not implemented')
    },
    stop(): Promise<void> {
      throw new Error('not implemented')
    },
    remove(): Promise<void> {
      throw new Error('not implemented')
    },
  }
}
export function kubernetesServiceRuntime(service: WorkItem<ContainerWorkService>): WorkRuntime<ServiceState> {
  return {
    initialize(item: State<ServiceState>): Promise<void> {
      throw new Error('not implemented')
    },
    restore(environment: Environment, path: string): Promise<void> {
      throw new Error('not implemented')
    },
    archive(environment: Environment, path: string): Promise<void> {
      throw new Error('not implemented')
    },
    stop(): Promise<void> {
      throw new Error('not implemented')
    },
    execute(environment: Environment, options: ExecuteOptions<ServiceState>): Promise<void> {
      throw new Error('not implemented')
    },
    remove(): Promise<void> {
      throw new Error('not implemented')
    },
  }
}

export function kubernetesForwardRuntime(service: WorkItem<KubernetesWorkService>): WorkRuntime<ServiceState> {
  return {
    initialize(item: State<ServiceState>): Promise<void> {
      throw new Error('not implemented')
    },
    async restore(environment: Environment, path: string): Promise<void> {},
    async archive(environment: Environment, path: string): Promise<void> {},
    async remove(): Promise<void> {},
    async execute(environment: Environment, options: ExecuteOptions<ServiceState>): Promise<void> {
      // TODO migrate away from kubectl
      await kubernetesService(service, options)
    },
    stop(): Promise<void> {
      throw new Error('not implemented')
    },
  }
}
