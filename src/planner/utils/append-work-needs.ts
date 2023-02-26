import { ReferenceService, ReferenceTask } from '../../schema/reference-parser'
import { WorkTask } from '../work-task'
import { WorkService } from '../work-service'
import { WorkTree } from '../work-tree'
import { appendWorkService } from './append-work-service'
import { Environment } from '../../executer/environment'
import { WorkItemState } from '../work-item'
import { TaskState } from '../../executer/scheduler/task-state'
import { ServiceState } from '../../executer/scheduler/service-state'

export function appendWorkNeeds(
  workTree: WorkTree,
  referenced: ReferenceService | ReferenceTask,
  item: WorkItemState<WorkTask, TaskState> | WorkItemState<WorkService, ServiceState>,
  environment: Environment
) {
  for (const need of referenced.needs) {
    const serviceNeed = appendWorkService(workTree, need.service, environment)
    item.needs.push({
      service: serviceNeed,
      name: need.relativeName,
    })
    if (!serviceNeed.requiredBy.some((r) => r.name === item.name)) {
      serviceNeed.requiredBy.push(item)
    }
  }
}
