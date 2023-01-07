import { WorkTree } from '../work-tree'
import { BuildFile } from '../../parser/build-file'
import { getWorkNode } from './plan-work-node'
import { createWorkContext } from '../work-context'
import { WorkNode } from '../work-node'
import { WorkTaskScope } from '../../executer/work-scope'

export function planWorkTree(build: BuildFile, options: WorkTaskScope): WorkTree & { rootNode: WorkNode } {
  const context = createWorkContext(build)
  const result = getWorkNode(context, { name: options.taskName })
  return {
    ...context.workTree,
    rootNode: result,
  }
}
