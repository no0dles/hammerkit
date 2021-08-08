import { WorkNode } from '../planner/work-node'
import { ExecutionContext } from './execution-context'
import { Defer } from '../utils/defer'
import { WorkTree } from '../planner/work-tree'

export interface Executor {
  exec(workTree: WorkTree, node: WorkNode, context: ExecutionContext, cancelDefer: Defer<void>): Promise<void>
}
