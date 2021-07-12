import {
  getLogLevel,
  getNodeName,
  getNodeNameLength,
  hideCursor,
  isVerbose,
  printWorkTreeResult,
  showCursor,
  writeWorkTreeStatus,
} from '../log'
import { ExecuteResult } from './execute-result'
import { WorkTree } from '../planner/work-tree'
import { ExecutionContext } from '../run-arg'
import { iterateWorkNodes } from '../planner/utils/plan-work-nodes'
import colors from 'colors'
import { WorkNodeConsoleLog } from '../planner/work-node-status'
import { WorkNode } from '../planner/work-node'
import { clearScreenDown } from 'readline'

export type LogMode = 'live' | 'interactive' | 'grouped'

export interface LogStrategy {
  start(executionContext: ExecutionContext, workTree: WorkTree): void

  finish(workTree: WorkTree, result: ExecuteResult): Promise<void>

  abort(e: Error): void
}

export function failNever(message: string): never {
  throw new Error(message)
}

export function getLogger(mode: LogMode): LogStrategy {
  if (mode === 'interactive') {
    return interactiveLogger()
  } else if (mode === 'live') {
    return liveLogger()
  } else if (mode === 'grouped') {
    return groupedLogger()
  } else {
    failNever(`Unknown logging mode ${mode}`)
  }
}

function logMessageToConsole(node: WorkNode, log: WorkNodeConsoleLog, maxNodeNameLength: number) {
  if (!isVerbose && log.level === 'debug') {
    return
  }

  process.stdout.write(
    `${colors.grey('task:')} ${getNodeName(node, maxNodeNameLength)} - ${log.date.toLocaleTimeString()} - ${getLogLevel(
      log.level
    )} - ${log.message}\n`
  )
}

export function groupedLogger(): LogStrategy {
  let maxNodeNameLength = 0

  return {
    start(executionContext: ExecutionContext, workTree: WorkTree) {
      maxNodeNameLength = getNodeNameLength(workTree)

      executionContext.events.on(async (evt) => {
        if (evt.newState.type === 'completed' || evt.newState.type === 'failed' || evt.newState.type === 'aborted') {
          const node = workTree.nodes[evt.nodeId]
          for (const log of await node.status.console.read()) {
            logMessageToConsole(node, log, maxNodeNameLength)
          }
        }
      })
    },
    async finish(workTree: WorkTree, result: ExecuteResult): Promise<void> {
      await printWorkTreeResult(workTree, result, false)
    },
    abort(e: Error) {
      console.error(e)
    },
  }
}

export function liveLogger(): LogStrategy {
  let maxNodeNameLength = 0

  return {
    start(executionContext: ExecutionContext, workTree: WorkTree) {
      maxNodeNameLength = getNodeNameLength(workTree)

      for (const node of iterateWorkNodes(workTree.nodes)) {
        node.status.console.on((log) => {
          logMessageToConsole(node, log, maxNodeNameLength)
        })
      }
    },
    async finish(workTree: WorkTree, result: ExecuteResult): Promise<void> {
      await printWorkTreeResult(workTree, result, false)
    },
    abort(e: Error) {
      console.error(e)
    },
  }
}

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
      clearScreenDown(process.stdout)
      await printWorkTreeResult(workTree, result, true)
      showCursor()
    },
    abort(e: Error) {
      console.error(e)
    },
  }
}
