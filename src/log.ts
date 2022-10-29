import { clearScreenDown, moveCursor } from 'readline'
import { iterateWorkNodes, iterateWorkServices } from './planner/utils/plan-work-nodes'
import { Message, WorkNodeConsoleLogLevel } from './planner/work-node-status'
import colors from 'colors'
import { ConsoleContext } from './console/console-context'
import { SchedulerNodeState, SchedulerServiceState, SchedulerState } from './executer/scheduler/scheduler-state'
import { NodeState } from './executer/scheduler/node-state'
import { ServiceState } from './executer/scheduler/service-state'
import { Environment } from './executer/environment'
import { failNever } from './utils/fail-never'

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

const typeLength = ['service', 'task'].map((s) => s.length).reduce((max, current) => (max > current ? max : current), 0)
export function getType(type: 'service' | 'task'): string {
  return colors.grey(getNodeName(type, typeLength) + ':')
}

export async function printWorkTreeResult(schedulerState: SchedulerState, env: Environment): Promise<void> {
  const maxNodeNameLength = getNodeNameLengthForSchedulerState(schedulerState)

  const logs = await env.status.read()
  for (const log of logs) {
    const stateType =
      log.context.type === 'task'
        ? schedulerState.node[log.context.id].type
        : schedulerState.service[log.context.id].type
    if (
      isVerbose ||
      (log.type === 'console' && log.console === 'stderr' && (stateType === 'crash' || stateType === 'error')) ||
      (log.type === 'status' && log.level === 'error')
    ) {
      process.stdout.write(
        `${formatDate(log.date)} ${getType(log.context.type)} ${getNodeName(
          log.context.name,
          maxNodeNameLength
        )} - ${log.date.toLocaleTimeString()} - ${colors.white(log.message)}\n`
      )
    }
  }

  for (const state of iterateWorkServices(schedulerState.service)) {
    let message = `${getType('service')} ${getNodeName(state.service.name, maxNodeNameLength)} - ${getStateText(state)}`
    if (state.type === 'end') {
      if (state.reason === 'crash') {
        message += ` crashed`
      }
      process.stdout.write(`${message}\n`)
    }
  }

  for (const state of iterateWorkNodes(schedulerState.node)) {
    let message = `${getType('task')} ${getNodeName(state.node.name, maxNodeNameLength)} - ${getStateText(state)}`
    if (state.type === 'completed') {
      message += ` in ${state.duration}ms`
      if (state.cached) {
        message += ' [CACHED]'
      }
    }
    if (state.type === 'crash') {
      message += ` exited with ${state.exitCode}`
    }
    if (state.type === 'error') {
      message += ` with message ${state.errorMessage}`
    }
    process.stdout.write(`${message}\n`)
  }
}

const spinner = '⠁⠁⠉⠙⠚⠒⠂⠂⠒⠲⠴⠤⠄⠄⠤⠠⠠⠤⠦⠖⠒⠐⠐⠒⠓⠋⠉⠈⠈'

function getStateText(state: NodeState | ServiceState): string {
  if (state.type === 'running') {
    return colors.blue(state.type)
  } else if (state.type === 'pending' || state.type === 'starting') {
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
    failNever(state, 'unknown node state')
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

export function printProperty(name: string, value: string) {
  process.stdout.write(`   ${colors.grey(`${name}:`)} ${value}\n`)
}

export function printItem(item: { name: string; description: string | null }) {
  process.stdout.write(`• ${item.name}${item.description ? `: ${colors.white(item.description)}` : ''}\n`)
}
export function printTitle(name: string) {
  process.stdout.write(`${colors.bgWhite(name + ':\n')}`)
}

export function getNodeNameLength(names: () => Generator<string> | Array<string>): number {
  let maxNodeNameLength = 0
  for (const name of names()) {
    if (name.length > maxNodeNameLength) {
      maxNodeNameLength = name.length
    }
  }
  return maxNodeNameLength
}

export function getNodeNameLengthForWorkTree(nodes: SchedulerNodeState, services: SchedulerServiceState): number {
  function* Names(): Generator<string> {
    for (const node of iterateWorkNodes(nodes)) {
      yield node.node.name
    }
    for (const service of iterateWorkServices(services)) {
      yield service.service.name
    }
  }

  return getNodeNameLength(Names)
}

export function getNodeName(name: string, maxNodeNameLength: number): string {
  return colors.white(name) + ' '.repeat(maxNodeNameLength - name.length)
}

export function writeNodeLogToConsole(log: Message, maxNodeNameLength: number): void {
  const content =
    log.type === 'console'
      ? log.console === 'stdout'
        ? colors.white(log.message)
        : colors.red(log.message)
      : `${getLogLevel(log.level)} - ${log.message}`
  process.stdout.write(
    `${formatDate(log.date)} ${colors.grey(log.context.type + ':')} ${getNodeName(
      log.context.name,
      maxNodeNameLength
    )} - ${log.date.toLocaleTimeString()} - ${content}\n`
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

export function writeWorkTreeStatus(schedulerState: SchedulerState, env: Environment, ticker: number): void {
  clearScreenDown(process.stdout)

  const maxNodeNameLength = getNodeNameLengthForSchedulerState(schedulerState)

  let count = 0

  for (const state of iterateWorkServices(schedulerState.service)) {
    let message = `${getType('service')} ${getNodeName(state.service.name, maxNodeNameLength)} - ${getStateText(state)}`

    const currentMessage = env.status.service(state.service).current()
    if (currentMessage) {
      message += ` ${currentMessage.message}`
    }

    count += printWithTruncate(message)
  }

  for (const state of iterateWorkNodes(schedulerState.node)) {
    let message = `${getType('task')} ${getNodeName(state.node.name, maxNodeNameLength)} - ${getStateText(state)}`

    if (state.type === 'pending') {
      const totalDepCount = state.node.deps.length
      const totalServiceCount = state.node.needs.length
      const completedDepCount = state.node.deps.filter((d) => schedulerState.node[d.id]?.type === 'completed').length
      const runningServiceCount = state.node.needs.filter((n) => schedulerState.service[n.id]?.type === 'ready').length
      if (totalDepCount > 0 && completedDepCount !== totalDepCount) {
        message += ` | ${colors.grey(` awaiting dependencies (${completedDepCount}/${totalDepCount})`)}`
      }
      if (totalServiceCount > 0 && runningServiceCount !== totalServiceCount) {
        message += ` | ${colors.grey(` awaiting service (${runningServiceCount}/${totalServiceCount})`)}`
      }
    }
    if (state.type === 'running' || state.type === 'starting') {
      message += ` | ${spinner[ticker % spinner.length]}`
      const currentMessage = env.status.task(state.node).current()
      if (currentMessage) {
        message += ` ${currentMessage.message}`
      }
    } else if (state.type === 'completed') {
      message += ` in ${state.duration}ms`
      if (state.cached) {
        message += ' [CACHED]'
      }
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
