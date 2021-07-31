import { WorkNode } from '../planner/work-node'
import { ExecutionContext } from './execution-context'
import { Defer } from '../utils/defer'

export interface Executor {
  exec(node: WorkNode, context: ExecutionContext, cancelDefer: Defer<void>): Promise<void>
}
