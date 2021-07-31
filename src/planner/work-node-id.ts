import { createHash } from 'crypto'
import { getWorkDescription } from '../optimizer/work-node-description'
import { MergedBuildFileTask, MergedDependency } from './utils/plan-work-node'

export function getWorkNodeId(task: MergedBuildFileTask, deps: MergedDependency[]) {
  const description = getWorkDescription(task, deps)
  const jsonData = JSON.stringify(description, Object.keys(description).sort())
  return createHash('sha1').update(jsonData).digest('hex')
}
