import { WorkEnvironment } from './work-environment'
import { WorkItemState } from './work-item'
import { WorkTask } from './work-task'
import { TaskState } from '../executer/scheduler/task-state'
import { WorkService } from './work-service'
import { ServiceState } from '../executer/scheduler/service-state'

export interface WorkTree {
  tasks: { [key: string]: WorkItemState<WorkTask, TaskState> }
  services: { [key: string]: WorkItemState<WorkService, ServiceState> }
  environment: WorkEnvironment
}
