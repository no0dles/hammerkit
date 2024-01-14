import { WorkTree } from '../planner/work-tree'
import { WorkItemState } from '../planner/work-item'
import { WorkTask } from '../planner/work-task'
import { TaskState } from './scheduler/task-state'
import { State } from './state'
import { WorkService } from '../planner/work-service'
import { ServiceState } from './scheduler/service-state'
import { ExecuteKind } from '../cli'

export function resetWorkTree(workTree: WorkTree, type: ExecuteKind): WorkTree {
  return {
    tasks: Object.entries(workTree.tasks).reduce<{ [key: string]: WorkItemState<WorkTask, TaskState> }>(
      (tasks, [key, task]) => {
        task.state = new State<TaskState>({
          type: 'pending',
          stateKey: null,
        })
        tasks[key] = task
        return tasks
      },
      {}
    ),
    services: Object.entries(workTree.services).reduce<{
      [key: string]: WorkItemState<WorkService, ServiceState>
    }>((services, [key, service]) => {
      if (type === 'execute' && service.requiredBy.length === 0) {
        return services
      }

      service.state = new State<ServiceState>({
        type: 'pending',
        stateKey: null,
      })
      services[key] = service
      return services
    }, {}),
    environment: workTree.environment,
  }
}
