import { WorkService } from '../planner/work-service'
import { WorkItem } from '../planner/work-item'
import { WorkTask } from '../planner/work-task'

// An object name is a DNS label: lowercase letters, digits and `-`, at most 63
// characters, starting and ending with a letter or digit. The id makes a name
// unique; the item's name is there for people and is cut to fit.
const MAX_NAME = 63

export function getResourceName(item: WorkItem<WorkService | WorkTask>, suffix?: string) {
  const tail = `-${item.id()}${suffix ?? ''}`
  const name = removeInvalidCharacters(item.name)
    .slice(0, Math.max(0, MAX_NAME - tail.length))
    .replace(/-+$/, '')
  return name ? name + tail : tail.slice(1)
}

export function removeInvalidCharacters(val: string) {
  return val
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '')
}
