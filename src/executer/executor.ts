import { WorkNode } from '../planner/work-node'
import { ExecutionContext } from './execution-context'
import { Environment } from './environment'
import { WorkService } from '../planner/work-service'
import { WorkTree } from '../planner/work-tree'
import { WorkNodes } from '../planner/work-nodes'
import { WorkServices } from '../planner/work-services'

export interface Executor {
  start(workTree: WorkTree, service: WorkService, context: ExecutionContext): ServiceProcess
  clean(node: WorkNode, environment: Environment): Promise<void>
  store(node: WorkNode, environment: Environment, path: string): Promise<void>
  restore(node: WorkNode, environment: Environment, path: string): Promise<void>
  exec(node: WorkNode, context: ExecutionContext, abortCtrl: AbortController): Promise<void>
  prepareRun(workNodes: WorkNodes, workServices: WorkServices): Promise<void>
}

export interface ServiceProcess {
  name: string
  stop(): Promise<void>
}
