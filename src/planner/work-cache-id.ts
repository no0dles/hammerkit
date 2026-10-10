import { createHash } from 'crypto'
import { getWorkTaskCacheDescription } from '../optimizer/work-task-cache-description'
import { WorkTask } from './work-task'
import { WorkItem } from './work-item'

export function getWorkTaskId(item: WorkItem<WorkTask>): string {
  const description = getWorkTaskCacheDescription(item)
  const jsonData = JSON.stringify(description)
  return createHash('sha1').update(jsonData).digest('hex')
}
