import { WorkNode } from '../planner/work-node'
import { WorkNodeConsoleLog } from '../planner/work-node-status'
import { getLogLevel, getNodeName, isVerbose } from '../log'
import colors from 'colors'

export function logMessageToConsole(node: WorkNode, log: WorkNodeConsoleLog, maxNodeNameLength: number) {
  if (!isVerbose && log.level === 'debug') {
    return
  }

  process.stdout.write(
    `${colors.grey('task:')} ${getNodeName(node, maxNodeNameLength)} - ${log.date.toLocaleTimeString()} - ${getLogLevel(
      log.level
    )} - ${log.message}\n`
  )
}
