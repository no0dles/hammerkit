import { createHash } from 'crypto'
import { getWorkDescription } from '../optimizer/work-node-description'
import { MergedBuildFileTask, MergedDependency } from './utils/plan-work-node'

export function getWorkNodeId(cwd: string, task: MergedBuildFileTask, deps: MergedDependency[]) {
  const description = getWorkDescription(cwd, task, deps)
  const jsonData = JSON.stringify(description)
  return createHash('sha1').update(jsonData).digest('hex')
}
