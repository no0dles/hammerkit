import { WorkTree } from '../work-tree'
import { BuildFile } from '../../parser/build-file'
import { getWorkNode } from './plan-work-node'
import { createWorkContext } from '../work-context'
import { WorkNode } from '../work-node'
import { CacheMethod } from '../../parser/cache-method'

export interface PlanOptions {
  taskName: string
  cache?: CacheMethod
}

export function planWorkTree(build: BuildFile, options: PlanOptions): WorkTree & { rootNode: WorkNode } {
  const context = createWorkContext(build, options.cache ?? null)
  const result = getWorkNode(context, { taskName: options.taskName })
  return {
    ...context.workTree,
    rootNode: result,
  }
}
