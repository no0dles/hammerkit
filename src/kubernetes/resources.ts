import { WorkService } from '../planner/work-service'
import { WorkItem } from '../planner/work-item'
import { WorkNode } from '../planner/work-node'

export function getResourceName(item: WorkItem<WorkService | WorkNode>, suffix?: string) {
  return `${item.name.replace(/:/, '-')}-${item.id}${suffix ?? ''}`
}
