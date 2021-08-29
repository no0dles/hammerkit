import { ExecutionContext } from '../executer/execution-context'
import { WorkTree } from '../planner/work-tree'
import { getNodeNameLength, printWorkTreeResult } from '../log'
import { ExecuteResult } from '../executer/execute-result'
import { LogStrategy } from './log-strategy'
import { logMessageToConsole } from './message-to-console'

export function groupedLogger(): LogStrategy {
  let maxNodeNameLength = 0

  return {
    start(executionContext: ExecutionContext, workTree: WorkTree) {
      maxNodeNameLength = getNodeNameLength(workTree)

      executionContext.events.on(async (evt) => {
        if (
          evt.type === 'node' &&
          (evt.newState.type === 'completed' || evt.newState.type === 'failed' || evt.newState.type === 'aborted')
        ) {
          const node = workTree.nodes[evt.nodeId]
          for (const log of await node.status.console.read()) {
            logMessageToConsole('task', node, log, maxNodeNameLength)
          }
        }
      })
    },
    async finish(workTree: WorkTree, result: ExecuteResult): Promise<void> {
      await printWorkTreeResult(workTree, result, false)
    },
    abort(e: Error) {
      process.stderr.write(`${e.message}\n`)
    },
  }
}
