import { WorkNode } from '../planner/work-node'
import { WorkNodeConsoleLog } from '../planner/work-node-status'
import { getLogLevel, getNodeName, isVerbose } from '../log'
import colors from 'colors'
import { WorkService } from '../planner/work-service'

export function logMessageToConsole(
  type: 'task',
  node: WorkNode,
  log: WorkNodeConsoleLog,
  maxNodeNameLength: number
): void
export function logMessageToConsole(
  type: 'service',
  service: WorkService,
  log: WorkNodeConsoleLog,
  maxNodeNameLength: number
): void
export function logMessageToConsole(
  type: 'task' | 'service',
  node: WorkNode | WorkService,
  log: WorkNodeConsoleLog,
  maxNodeNameLength: number
): void {
  if (!isVerbose && log.level === 'debug') {
    return
  }

  process.stdout.write(
    `${colors.grey(type + ':')} ${getNodeName(
      node.name,
      maxNodeNameLength
    )} - ${log.date.toLocaleTimeString()} - ${getLogLevel(log.level)} - ${log.message}\n`
  )
}
