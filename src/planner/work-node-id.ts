import { createHash } from 'crypto'
import { PlannedTask } from './utils/plan-work-node'
import { getWorkNodeCacheDescription } from '../optimizer/work-node-cache-description'

export function getWorkNodeId(task: PlannedTask): string {
  const description = getWorkNodeCacheDescription(task, null)
  const jsonData = JSON.stringify(description)
  return createHash('sha1').update(jsonData).digest('hex')
}
