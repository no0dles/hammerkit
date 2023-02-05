import { createHash } from 'crypto'
import { getWorkNodeCacheDescription } from '../optimizer/work-node-cache-description'
import { WorkNode } from './work-node'

export function getWorkNodeId(task: WorkNode): string {
  const description = getWorkNodeCacheDescription(task)
  const jsonData = JSON.stringify(description)
  return createHash('sha1').update(jsonData).digest('hex')
}
