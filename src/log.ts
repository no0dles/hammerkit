import { clearScreenDown, moveCursor } from 'readline'
import { iterateWorkNodes, iterateWorkServices } from './planner/utils/plan-work-nodes'
import { ConsoleMessage, WorkNodeConsoleLogLevel } from './planner/work-node-status'
import colors from 'colors'
import { ConsoleContext } from './console/console-context'
import { WorkNodes } from './planner/work-nodes'
import { WorkServices } from './planner/work-services'
import { SchedulerState } from './executer/scheduler/scheduler-state'
import { NodeState } from './executer/scheduler/node-state'
import { ServiceState } from './executer/scheduler/service-state'
import { WorkNode } from './planner/work-node'
import { WorkService } from './planner/work-service'

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

export async function printWorkTreeResult(schedulerState: SchedulerState, logConsoleOnFail: boolean): Promise<void> {
  const maxNodeNameLength = getNodeNameLengthForSchedulerState(schedulerState)

  if (logConsoleOnFail && (schedulerState.abort || isVerbose)) {
    for (const serviceState of iterateWorkServices(schedulerState.service)) {
      if (isVerbose) {
        const logs = await serviceState.service.console.read()
        for (const log of logs) {
          writeServiceLogToConsole(serviceState.service, log, maxNodeNameLength)
        }
        if (logs.length > 0) {
          process.stdout.write('-----------------\n')
        }
      }
    }

    for (const state of iterateWorkNodes(schedulerState.node)) {
      if (state.type === 'crash' || state.type === 'error' || isVerbose) {
        const logs = await state.node.console.read()
        for (const log of logs) {
          writeNodeLogToConsole(state.node, log, maxNodeNameLength)
        }
        if (logs.length > 0) {
          process.stdout.write('-----------------\n')
        }
      }
    }
  }

  for (const state of iterateWorkNodes(schedulerState.node)) {
    let message = `${colors.grey('task:')} ${getNodeName(state.node.name, maxNodeNameLength)} - ${getStateText(state)}`
    if (state.type === 'completed') {
      message += ` in ${state.duration}ms`
    }
    if (state.type === 'crash') {
      message += ` exited with ${state.exitCode}`
    }
    if (state.type === 'error') {
      message += ` errored with ${state.errorMessage}`
    }
    process.stdout.write(`${message}\n`)
  }
}

const spinner = '⠁⠁⠉⠙⠚⠒⠂⠂⠒⠲⠴⠤⠄⠄⠤⠠⠠⠤⠦⠖⠒⠐⠐⠒⠓⠋⠉⠈⠈'

function getStateText(state: NodeState | ServiceState): string {
  if (state.type === 'running') {
    return colors.blue(state.type)
  } else if (state.type === 'pending') {
    return colors.yellow(state.type)
  } else if (state.type === 'completed') {
    return colors.green(state.type)
  } else if (state.type === 'crash') {
    return colors.red(state.type)
  } else if (state.type === 'error') {
    return colors.red(state.type)
  } else if (state.type === 'end') {
    return colors.bgRed(state.type)
  } else if (state.type === 'canceled') {
    return colors.bgRed(state.type)
  } else if (state.type === 'ready') {
    return colors.blue(state.type)
  } else {
    //TODO fail never
    return ''
  }
}
export function getNodeNameLengthForSchedulerState(schedulerState: SchedulerState): number {
  function* Names(): Generator<string> {
    for (const node of iterateWorkNodes(schedulerState.node)) {
      yield node.node.name
    }
    for (const service of iterateWorkServices(schedulerState.service)) {
      yield service.service.name
    }
  }

  return getNodeNameLength(Names)
}

export function getNodeNameLength(names: () => Generator<string>): number {
  let maxNodeNameLength = 0
  for (const name of names()) {
    if (name.length > maxNodeNameLength) {
      maxNodeNameLength = name.length
    }
  }
  return maxNodeNameLength
}

export function getNodeNameLengthForWorkTree(nodes: WorkNodes, services: WorkServices): number {
  function* Names(): Generator<string> {
    for (const node of iterateWorkNodes(nodes)) {
      yield node.name
    }
    for (const service of iterateWorkServices(services)) {
      yield service.name
    }
  }

  return getNodeNameLength(Names)
}

export function getNodeName(name: string, maxNodeNameLength: number): string {
  return colors.white(name) + ' '.repeat(maxNodeNameLength - name.length)
}

export function writeNodeLogToConsole(node: WorkNode, log: ConsoleMessage, maxNodeNameLength: number): void {
  process.stdout.write(
    `${formatDate(log.date)} ${colors.grey('task:')} ${getNodeName(
      node.name,
      maxNodeNameLength
    )} - ${log.date.toLocaleTimeString()} - ${
      log.type === 'stdout' ? colors.white(log.message) : colors.red(log.message)
    }\n`
  )
}

export function writeServiceLogToConsole(service: WorkService, log: ConsoleMessage, maxNodeNameLength: number): void {
  process.stdout.write(
    `${formatDate(log.date)} ${colors.grey('service:')} ${getNodeName(
      service.name,
      maxNodeNameLength
    )} - ${log.date.toLocaleTimeString()} - ${
      log.type === 'stdout' ? colors.white(log.message) : colors.red(log.message)
    }\n`
  )
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

export function writeWorkTreeStatus(schedulerState: SchedulerState, ticker: number): void {
  clearScreenDown(process.stdout)

  const maxNodeNameLength = getNodeNameLengthForSchedulerState(schedulerState)

  let count = 0

  for (const state of iterateWorkServices(schedulerState.service)) {
    let message = `${colors.grey('service:')} ${getNodeName(state.service.name, maxNodeNameLength)} - ${getStateText(
      state
    )}`

    if (state.service.console.current) {
      message += ` ${state.service.console.current.message}`
    }

    count += printWithTruncate(message)
  }

  for (const state of iterateWorkNodes(schedulerState.node)) {
    let message = `${colors.grey('task:')} ${getNodeName(state.node.name, maxNodeNameLength)} - ${getStateText(state)}`

    if (state.type === 'pending') {
      const totalDepCount = state.node.deps.length
      const totalServiceCount = state.node.needs.length
      const completedDepCount = state.node.deps.filter((d) => schedulerState.node[d.id].type === 'completed').length
      const runningServiceCount = state.node.needs.filter((n) => schedulerState.service[n.id].type === 'ready').length
      if (totalDepCount > 0 && completedDepCount !== totalDepCount) {
        message += ` | ${colors.grey(` awaiting dependencies (${completedDepCount}/${totalDepCount})`)}`
      }
      if (totalServiceCount > 0 && runningServiceCount !== totalServiceCount) {
        message += ` | ${colors.grey(` awaiting service (${runningServiceCount}/${totalServiceCount})`)}`
      }
    }
    if (state.type === 'running') {
      message += ` | ${spinner[ticker % spinner.length]}`
      if (state.node.console.current) {
        message += ` ${state.node.console.current.message}`
      }
    } else if (state.type === 'completed') {
      message += ` in ${state.duration}ms`
    }

    count += printWithTruncate(message)
  }

  moveCursor(process.stdout, 0, -1 * count)
}

function printWithTruncate(message: string): number {
  let lineCount = 0
  let index = 0
  do {
    process.stdout.write(`${message.substr(index, process.stdout.columns)}\n`)
    index += process.stdout.columns
    lineCount++
  } while (index < message.length)
  return lineCount
}

export function hideCursor(): void {
  process.stdout.write('\x1B[?25l')
}

export function showCursor(): void {
  process.stdout.write('\x1B[?25h')
}
