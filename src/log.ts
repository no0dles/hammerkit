import { WorkTree } from './planner/work-tree'
import { clearScreenDown, moveCursor } from 'readline'
import { iterateWorkNodes, iterateWorkServices } from './planner/utils/plan-work-nodes'
import { WorkNodeConsoleLogLevel, WorkNodeState } from './planner/work-node-status'
import colors from 'colors'
import { ExecuteResult } from './executer/execute-result'
import { ConsoleContext } from './console/console-context'
import { WorkServiceState } from './planner/work-service-state'

export function getLogs(chunk: Buffer | string): string[] {
  return chunk
    .toString()
    .split(/\r?\n/)
    .filter((s) => !!s)
}

export function getLogLevel(level: WorkNodeConsoleLogLevel): string {
  switch (level) {
    case 'debug':
      return colors.bgMagenta(level)
    case 'info':
      return ` ` + level
    case 'warn':
      return ` ` + colors.yellow(level)
    case 'error':
      return colors.red(level)
  }
}

export function getErrorMessage(e: unknown): string {
  if (e instanceof Error) {
    return e.message
  } else if (typeof e === 'string') {
    return e
  } else {
    return `unknown error ${e}`
  }
}

export function consoleContext(): ConsoleContext {
  return {
    debug(message: string): void {
      process.stdout.write(`${getLogLevel('debug')}: ${message}\n`)
    },
    error(message: string): void {
      process.stdout.write(`${getLogLevel('error')}: ${message}\n`)
    },
    info(message: string): void {
      process.stdout.write(`${getLogLevel('info')}: ${message}\n`)
    },
    warn(message: string): void {
      process.stdout.write(`${getLogLevel('warn')}: ${message}\n`)
    },
  }
}

export const isVerbose = process.argv.some((a) => a === '--verbose')

export async function printWorkTreeResult(
  workTree: WorkTree,
  result: ExecuteResult,
  logConsoleOnFail: boolean
): Promise<void> {
  const maxNodeNameLength = getNodeNameLength(workTree)

  if (logConsoleOnFail && (!result.success || isVerbose)) {
    for (const service of iterateWorkServices(workTree.services)) {
      if (isVerbose) {
        const logs = await service.status.console.read()
        for (const log of logs) {
          if (log.level === 'debug' && !isVerbose) {
            continue
          }
          process.stdout.write(
            `${colors.grey('service:')} ${getNodeName(service.name, maxNodeNameLength)} ${formatDate(
              log.date
            )} ${getLogLevel(log.level)}: ${log.message}\n`
          )
        }
        if (logs.length > 0) {
          process.stdout.write('-----------------\n')
        }
      }
    }

    for (const node of iterateWorkNodes(workTree.nodes)) {
      if (node.status.state.type === 'failed' || isVerbose) {
        const logs = await node.status.console.read()
        for (const log of logs) {
          if (log.level === 'debug' && !isVerbose) {
            continue
          }
          process.stdout.write(
            `${colors.grey('task:')} ${getNodeName(node.name, maxNodeNameLength)} ${formatDate(log.date)} ${getLogLevel(
              log.level
            )}: ${log.message}\n`
          )
        }
        if (logs.length > 0) {
          process.stdout.write('-----------------\n')
        }
      }
    }
  }

  for (const node of iterateWorkNodes(workTree.nodes)) {
    let message = `${colors.grey('task:')} ${getNodeName(node.name, maxNodeNameLength)} - ${getStateText(
      node.status.state
    )}`
    if (node.status.state.type === 'completed') {
      message += ` in ${node.status.state.duration}ms`
    }
    if (node.status.state.type === 'failed') {
      message += ` ${node.status.state.errorMessage}`
    }
    process.stdout.write(`${message}\n`)
  }
}

const spinner = '⠁⠁⠉⠙⠚⠒⠂⠂⠒⠲⠴⠤⠄⠄⠤⠠⠠⠤⠦⠖⠒⠐⠐⠒⠓⠋⠉⠈⠈'

function getStateText(state: WorkNodeState | WorkServiceState): string {
  if (state.type === 'running') {
    return colors.blue(state.type)
  } else if (state.type === 'pending') {
    return colors.yellow(state.type)
  } else if (state.type === 'completed') {
    return colors.green(state.type)
  } else if (state.type === 'failed') {
    return colors.red(state.type)
  } else if (state.type === 'aborted') {
    return colors.red(state.type)
  } else if (state.type === 'cancel') {
    return colors.bgRed(state.type)
  } else if (state.type === 'ready') {
    return colors.blue(state.type)
  } else {
    //TODO fail never
    return ''
  }
}

export function getNodeNameLength(workTree: WorkTree): number {
  let maxNodeNameLength = 0
  for (const node of iterateWorkNodes(workTree.nodes)) {
    if (node.name.length > maxNodeNameLength) {
      maxNodeNameLength = node.name.length
    }
  }
  for (const service of Object.values(workTree.services)) {
    if (service.name.length > maxNodeNameLength) {
      maxNodeNameLength = service.name.length
    }
  }
  return maxNodeNameLength
}

export function getNodeName(name: string, maxNodeNameLength: number): string {
  return colors.white(name) + ' '.repeat(maxNodeNameLength - name.length)
}

export function formatDate(date: Date): string {
  return colors.grey(
    `[${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date
      .getDay()
      .toString()
      .padStart(2, '0')} ${date.getHours().toString().padStart(2, '0')}:${date
      .getMinutes()
      .toString()
      .padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}.${date
      .getMilliseconds()
      .toString()
      .padStart(3, '0')}]`
  )
}

export function writeWorkTreeStatus(workTree: WorkTree, ticker: number): void {
  clearScreenDown(process.stdout)

  const maxNodeNameLength = getNodeNameLength(workTree)

  let count = 0
  for (const node of iterateWorkNodes(workTree.nodes)) {
    let message = `${colors.grey('task:')} ${getNodeName(node.name, maxNodeNameLength)} - ${getStateText(
      node.status.state
    )}`

    if (node.status.state.type === 'pending') {
      const totalDepCount = node.deps.length
      const totalServiceCount = node.needs.length
      const completedDepCount = totalDepCount - Object.keys(node.status.state.pendingDependencies).length
      const runningServiceCount = totalServiceCount - Object.keys(node.status.state.pendingServices).length
      if (totalDepCount > 0 && completedDepCount !== totalDepCount) {
        message += ` | ${colors.grey(` awaiting dependencies (${completedDepCount}/${totalDepCount})`)}`
      }
      if (totalServiceCount > 0 && runningServiceCount !== totalServiceCount) {
        message += ` | ${colors.grey(` awaiting service (${runningServiceCount}/${totalServiceCount})`)}`
      }
    }
    if (node.status.state.type === 'running') {
      message += ` | ${spinner[ticker % spinner.length]}`
      if (node.status.console.current) {
        message += ` ${node.status.console.current.message}`
      }
    } else if (node.status.state.type === 'completed') {
      message += ` in ${node.status.state.duration}ms`
    }
    process.stdout.write(`${message}\n`)
    count++
  }

  for (const service of Object.values(workTree.services)) {
    let message = `${colors.grey('service:')} ${getNodeName(service.name, maxNodeNameLength)} - ${getStateText(
      service.status.state
    )}`

    if (service.status.console.current) {
      message += ` ${service.status.console.current.message}`
    }

    process.stdout.write(`${message}\n`)
    count++
  }

  moveCursor(process.stdout, 0, -1 * count)
}

export function hideCursor(): void {
  process.stdout.write('\x1B[?25l')
}

export function showCursor(): void {
  process.stdout.write('\x1B[?25h')
}
