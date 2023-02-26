import { WorkService } from '../planner/work-service'
import { WorkItem } from '../planner/work-item'
import { WorkTask } from '../planner/work-task'

export function getResourceName(item: WorkItem<WorkService | WorkTask>, suffix?: string) {
  return `${item.name.replace(/:/, '-')}-${item.cacheId()}${suffix ?? ''}`
}
