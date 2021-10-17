import { WorkNode } from '../planner/work-node'
import { WorkNodeConsoleLog } from '../planner/work-node-status'
import { getLogLevel, getNodeName, isVerbose } from '../log'
import colors from 'colors'
import { WorkService } from '../planner/work-service'

export function logMessageToConsole(
  log: WorkNodeConsoleLog,
  context: {
    type: 'general'
  }
): void
export function logMessageToConsole(
  log: WorkNodeConsoleLog,
  context: {
    type: 'task'
    node: WorkNode
    maxNodeNameLength: number
  }
): void
export function logMessageToConsole(
  log: WorkNodeConsoleLog,
  context: {
    type: 'service'
    service: WorkService
    maxNodeNameLength: number
  }
): void
export function logMessageToConsole(
  log: WorkNodeConsoleLog,
  context:
    | {
        type: 'general'
      }
    | {
        type: 'task'
        node: WorkNode
        maxNodeNameLength: number
      }
    | {
        type: 'service'
        service: WorkService
        maxNodeNameLength: number
      }
): void {
  if (!isVerbose && log.level === 'debug') {
    return
  }

  if (context.type === 'general') {
    process.stdout.write(`${log.date.toLocaleTimeString()} - ${getLogLevel(log.level)} - ${log.message}\n`)
  } else if (context.type === 'task') {
    process.stdout.write(
      `${colors.grey(context.type + ':')} ${getNodeName(
        context.node.name,
        context.maxNodeNameLength
      )} - ${log.date.toLocaleTimeString()} - ${getLogLevel(log.level)} - ${log.message}\n`
    )
  } else if (context.type === 'service') {
    process.stdout.write(
      `${colors.grey(context.type + ':')} ${getNodeName(
        context.service.name,
        context.maxNodeNameLength
      )} - ${log.date.toLocaleTimeString()} - ${getLogLevel(log.level)} - ${log.message}\n`
    )
  }
}
