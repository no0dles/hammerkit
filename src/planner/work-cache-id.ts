import { createHash } from 'crypto'
import { getWorkTaskCacheDescription } from '../optimizer/work-task-cache-description'
import { WorkTask } from './work-task'

export function getWorkCacheId(task: WorkTask): string {
  const description = getWorkTaskCacheDescription(task)
  const jsonData = JSON.stringify(description)
  return createHash('sha1').update(jsonData).digest('hex')
}
