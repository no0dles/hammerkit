import { BuildFile } from './parser/build-file'
import { WorkTree } from './planner/work-tree'
import { planWorkTree } from './planner/utils/plan-work-tree'
import { planWorkNodes } from './planner/utils/plan-work-nodes'
import { isContextTaskFilter, WorkScope } from './executer/work-scope'

export function getWorkScope(buildFile: BuildFile, contextFilter: WorkScope): WorkTree {
  return isContextTaskFilter(contextFilter)
    ? planWorkTree(buildFile, { taskName: contextFilter.taskName })
    : planWorkNodes(buildFile, contextFilter)
}
