import { createHash } from 'crypto'
import { getWorkNodeCacheDescription } from '../optimizer/work-node-cache-description'
import { PlannedTask } from './utils/planned-task'

export function getWorkNodeId(task: PlannedTask): string {
  const description = getWorkNodeCacheDescription(task)
  const jsonData = JSON.stringify(description)
  return createHash('sha1').update(jsonData).digest('hex')
}
