import { ExecutionContext } from '../executer/execution-context'
import { WorkTree } from '../planner/work-tree'
import { hideCursor, printWorkTreeResult, showCursor, writeWorkTreeStatus } from '../log'
import { ExecuteResult } from '../executer/execute-result'
import { clearScreenDown } from 'readline'
import { LogStrategy } from './log-strategy'

export function interactiveLogger(): LogStrategy {
  let running = true
  let count = 0

  return {
    start(executionContext: ExecutionContext, workTree: WorkTree) {
      hideCursor()
      writeWorkTreeStatus(workTree, count)

      const tickerFn = () => {
        count++
        writeWorkTreeStatus(workTree, count)
        if (running) {
          setTimeout(tickerFn, 100)
        }
      }
      tickerFn()

      executionContext.events.on(({ workTree }) => {
        writeWorkTreeStatus(workTree, count)
      })
    },
    async finish(workTree: WorkTree, result: ExecuteResult) {
      running = false
      clearScreenDown(process.stdout)
      await printWorkTreeResult(workTree, result, true)
      showCursor()
    },
    abort(e: Error) {
      process.stderr.write(`${e.message}\n`)
    },
  }
}
