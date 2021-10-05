import { ExecutionContext } from '../executer/execution-context'
import { WorkTree } from '../planner/work-tree'
import { getNodeNameLength, printWorkTreeResult } from '../log'
import { iterateWorkNodes } from '../planner/utils/plan-work-nodes'
import { ExecuteResult } from '../executer/execute-result'
import { logMessageToConsole } from './message-to-console'
import { LogStrategy } from './log-strategy'

export function liveLogger(): LogStrategy {
  let maxNodeNameLength = 0

  return {
    start(executionContext: ExecutionContext, workTree: WorkTree) {
      maxNodeNameLength = getNodeNameLength(workTree)

      for (const node of iterateWorkNodes(workTree.nodes)) {
        node.status.console.on((log) => {
          logMessageToConsole(log, { type: 'task', node, maxNodeNameLength })
        })
      }

      for (const service of Object.values(workTree.services)) {
        service.status.console.on((log) => {
          logMessageToConsole(log, { type: 'service', service, maxNodeNameLength })
        })
      }
    },
    async finish(workTree: WorkTree, result: ExecuteResult): Promise<void> {
      await printWorkTreeResult(workTree, result, false)
    },
    abort(e: Error) {
      process.stderr.write(`${e.message}\n`)
    },
  }
}
