import { WorkNode } from '../planner/work-node'
import { ExecutionContext } from './execution-context'
import { Environment } from './environment'
import { WorkService } from '../planner/work-service'
import { WorkTree } from '../planner/work-tree'

export interface Executor {
  start(workTree: WorkTree, service: WorkService, context: ExecutionContext): ServiceProcess
  clean(node: WorkNode, environment: Environment): Promise<void>
  store(node: WorkNode, environment: Environment, path: string): Promise<void>
  restore(node: WorkNode, environment: Environment, path: string): Promise<void>
  exec(node: WorkNode, context: ExecutionContext, cancelDefer: AbortController): Promise<void>
}

export interface ServiceProcess {
  stop(): Promise<void>
}
