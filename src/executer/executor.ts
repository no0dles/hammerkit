import { WorkNode } from '../planner/work-node'
import { ExecutionContext } from './execution-context'
import { Environment } from './environment'

export interface Executor {
  clean(node: WorkNode, environment: Environment): Promise<void>
  store(node: WorkNode, environment: Environment, path: string): Promise<void>
  restore(node: WorkNode, environment: Environment, path: string): Promise<void>
  exec(node: WorkNode, context: ExecutionContext, cancelDefer: AbortController): Promise<void>
}
