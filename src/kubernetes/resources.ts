import { WorkService } from '../planner/work-service'
import { WorkItem } from '../planner/work-item'
import { WorkTask } from '../planner/work-task'

export function getResourceName(item: WorkItem<WorkService | WorkTask>, suffix?: string) {
  return removeInvalidCharacters(item.name) + '-' + item.id() + (suffix ?? '')
}

export function removeInvalidCharacters(val: string) {
  return val.replace(/:/g, '-').replace(/\./g, '-')
}
