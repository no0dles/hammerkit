import { ReferenceService, ReferenceTask } from '../../schema/reference-parser'
import { WorkNode } from '../work-node'
import { WorkService } from '../work-service'
import { WorkTree } from '../work-tree'
import { appendWorkService } from './append-work-service'
import { Environment } from '../../executer/environment'
import { WorkItem } from '../work-item'

export function appendWorkNeeds(
  workTree: WorkTree,
  referenced: ReferenceService | ReferenceTask,
  item: WorkItem<WorkNode | WorkService>,
  environment: Environment
) {
  for (const need of referenced.needs) {
    const serviceNeed = appendWorkService(workTree, need.service, environment)
    item.needs.push({
      service: serviceNeed,
      name: need.relativeName,
    })
  }
}
