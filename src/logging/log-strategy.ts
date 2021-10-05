import { ExecutionContext } from '../executer/execution-context'
import { WorkTree } from '../planner/work-tree'
import { ExecuteResult } from '../executer/execute-result'

export interface LogStrategy {
  start(executionContext: ExecutionContext, workTree: WorkTree): void

  finish(workTree: WorkTree, result: ExecuteResult): Promise<void>

  abort(e: unknown): void
}
