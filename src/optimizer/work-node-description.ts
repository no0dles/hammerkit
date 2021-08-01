import { MergedBuildFileTask, MergedDependency } from '../planner/utils/plan-work-node'
import { getWorkNodeCacheDescription, WorkNodeCacheDescription } from './work-node-cache-description'

export interface WorkNodeDescription extends WorkNodeCacheDescription {
  cwd: string
}

export function getWorkDescription(
  cwd: string,
  task: MergedBuildFileTask,
  deps: MergedDependency[]
): WorkNodeDescription {
  return {
    cwd,
    ...getWorkNodeCacheDescription(task, deps),
  }
}
