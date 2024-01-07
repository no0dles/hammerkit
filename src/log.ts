import { clearScreenDown, moveCursor } from 'readline'
import { iterateWorkTasks, iterateWorkServices } from './planner/utils/plan-work-tasks'
import { Message, WorkItemLogLevel } from './planner/work-item-status'
import colors from 'colors'
import { ConsoleContext } from './console/console-context'
import { TaskState } from './executer/scheduler/task-state'
import { ServiceState } from './executer/scheduler/service-state'
import { Environment } from './executer/environment'
import { failNever } from './utils/fail-never'
import { Writable } from 'stream'
import { WorkTree } from './planner/work-tree'

export function getLogs(chunk: Buffer | string): string[] {
  return chunk
    .toString()
    .split(/\r?\n/)
    .filter((s) => !!s)
}

export function getLogLevel(level: WorkItemLogLevel): string {
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

export function consoleContext(stream: Writable): ConsoleContext {
  return {
    debug(message: string): void {
      stream.write(`${formatDate(new Date())} ${getType('cli')} ${getLogLevel('debug')}: ${message}\n`)
    },
    error(message: string): void {
      stream.write(`${formatDate(new Date())} ${getType('cli')} ${getLogLevel('error')}: ${message}\n`)
    },
    info(message: string): void {
      stream.write(`${formatDate(new Date())} ${getType('cli')} ${getLogLevel('info')}: ${message}\n`)
    },
    warn(message: string): void {
      stream.write(`${formatDate(new Date())} ${getType('cli')} ${getLogLevel('warn')}: ${message}\n`)
    },
  }
}

export const isVerbose = process.argv.some((a) => a === '--verbose') || process.env['VERBOSE'] === 'true'

const typeLength = ['service', 'task', 'cli']
  .map((s) => s.length)
  .reduce((max, current) => (max > current ? max : current), 0)
export function getType(type: 'service' | 'task' | 'cli'): string {
  return colors.grey(getNodeName(type, typeLength) + ':')
}

export async function printWorkTreeResult(schedulerState: WorkTree, env: Environment): Promise<void> {
  const maxNodeNameLength = getWorkItemMaxLength(schedulerState)

  for (const log of env.status.read()) {
    if (isVerbose || (log.type === 'status' && log.level === 'error')) {
      env.stdout.write(
        `${formatDate(log.date)} ${getType(log.context.type)} ${getNodeName(
          log.context.name,
          maxNodeNameLength
        )} - ${colors.white(log.message)}\n`
      )
    }
  }

  for (const service of iterateWorkServices(schedulerState)) {
    if (service.state.current.type === 'end' && service.state.current.reason === 'crash') {
      const message = `${getType('service')} ${getNodeName(service.name, maxNodeNameLength)}`
      for (const log of service.status.logs()) {
        env.stdout.write(`${formatDate(log.date)} ${message} - ${log.console}: ${log.message}\n`)
      }
    } else if (service.state.current.type === 'running') {
      const message = `${getType('service')} ${getNodeName(service.name, maxNodeNameLength)}`
      if (service.state.current.remote) {
        env.stdout.write(`${formatDate(new Date())} ${message} - already started\n`)
      } else {
        env.stdout.write(`${formatDate(new Date())} ${message} - sucessfull started\n`)
      }
    }
  }

  for (const task of iterateWorkTasks(schedulerState)) {
    if (task.state.current.type === 'error' || task.state.current.type === 'crash') {
      const message = `${getType('task')} ${getNodeName(task.name, maxNodeNameLength)}`
      for (const log of task.status.logs()) {
        env.stdout.write(`${formatDate(log.date)} ${message} - ${log.console}: ${log.message}\n`)
      }
    }
  }

  for (const service of iterateWorkServices(schedulerState)) {
    let message = `${formatDate(new Date())} ${getType('service')} ${getNodeName(
      service.name,
      maxNodeNameLength
    )} - ${getStateText(service.state.current)}`
    if (service.state.current.type === 'end') {
      if (service.state.current.reason === 'crash') {
        message += ` crashed`
      }
      env.stdout.write(`${message}\n`)
    }
  }

  for (const task of iterateWorkTasks(schedulerState)) {
    let message = `${formatDate(new Date())} ${getType('task')} ${getNodeName(
      task.name,
      maxNodeNameLength
    )} - ${getStateText(task.state.current)}`
    if (task.state.current.type === 'completed') {
      message += ` in ${task.state.current.duration}ms`
      if (task.state.current.cached) {
        message += ' [CACHED]'
      }
    }
    if (task.state.current.type === 'crash') {
      message += ` exited with ${task.state.current.exitCode}`
    }
    if (task.state.current.type === 'error') {
      message += ` with message ${task.state.current.errorMessage}`
    }
    env.stdout.write(`${message}\n`)
  }
}

const spinner = '⠁⠁⠉⠙⠚⠒⠂⠂⠒⠲⠴⠤⠄⠄⠤⠠⠠⠤⠦⠖⠒⠐⠐⠒⠓⠋⠉⠈⠈'

function getStateText(state: TaskState | ServiceState): string {
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
    failNever(state, 'unknown task state')
  }
}

export function getWorkItemMaxLength(schedulerState: WorkTree): number {
  function* Names(): Generator<string> {
    for (const task of iterateWorkTasks(schedulerState)) {
      yield task.name
    }
    for (const service of iterateWorkServices(schedulerState)) {
      yield service.name
    }
  }

  return getMaxNameLength(Names)
}

export function printProperty(env: Environment, name: string, value: string) {
  env.stdout.write(`   ${colors.grey(`${name}:`)} ${value}\n`)
}

export function printItem(env: Environment, item: { name: string; description: string | null }) {
  env.stdout.write(`• ${item.name}${item.description ? `: ${colors.white(item.description)}` : ''}\n`)
}
export function printTitle(env: Environment, name: string) {
  env.stdout.write(`${colors.bgWhite(name + ':\n')}`)
}

export function getMaxNameLength(names: () => Generator<string> | Array<string>): number {
  let maxNodeNameLength = 0
  for (const name of names()) {
    if (name.length > maxNodeNameLength) {
      maxNodeNameLength = name.length
    }
  }
  return maxNodeNameLength
}

export function getNodeName(name: string, maxNodeNameLength: number): string {
  return colors.white(name) + ' '.repeat(Math.max(0, maxNodeNameLength - name.length))
}

export function writeWorkItemLogToConsole(env: Environment, log: Message, maxNodeNameLength: number): void {
  if (log.type === 'status') {
    if (log.level === 'debug' && !isVerbose) {
      return
    }
  }

  const content =
    log.type === 'console'
      ? log.console === 'stdout'
        ? colors.white(log.message)
        : colors.red(log.message)
      : `${getLogLevel(log.level)} - ${log.message}`
  env.stdout.write(
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

export function writeWorkTreeStatus(schedulerState: WorkTree, env: Environment, ticker: number): void {
  clearScreenDown(env.stdout)

  const maxNodeNameLength = getWorkItemMaxLength(schedulerState)

  let count = 0

  for (const service of iterateWorkServices(schedulerState)) {
    let message = `${getType('service')} ${getNodeName(service.name, maxNodeNameLength)} - ${getStateText(
      service.state.current
    )}`

    if (service.state.current.type === 'running' && service.state.current.remote) {
      message += ` [REMOTE]`
    }

    const currentMessage = service.status.currentLog()
    if (currentMessage) {
      message += ` ${currentMessage.message}`
    }

    count += printWithTruncate(env, message)
  }

  for (const task of iterateWorkTasks(schedulerState)) {
    let message = `${getType('task')} ${getNodeName(task.name, maxNodeNameLength)} - ${getStateText(
      task.state.current
    )}`

    if (task.state.current.type === 'pending') {
      const totalDepCount = task.deps.length
      const totalServiceCount = task.needs.length
      const completedDepCount = task.deps.filter((d) => d.state.current.type === 'completed').length
      const runningServiceCount = task.needs.filter((n) => n.service.state.current.type === 'ready').length
      if (totalDepCount > 0 && completedDepCount !== totalDepCount) {
        message += ` | ${colors.grey(` awaiting dependencies (${completedDepCount}/${totalDepCount})`)}`
      }
      if (totalServiceCount > 0 && runningServiceCount !== totalServiceCount) {
        message += ` | ${colors.grey(` awaiting service (${runningServiceCount}/${totalServiceCount})`)}`
      }
    }
    if (task.state.current.type === 'starting' || task.state.current.type === 'ready') {
      message += ` | ${spinner[ticker % spinner.length]}`
      const currentMessage = task.status.current()
      if (currentMessage) {
        message += ` ${currentMessage.message}`
      }
    } else if (task.state.current.type === 'running') {
      message += ` | ${spinner[ticker % spinner.length]}`
      const currentMessage = task.status.currentLog()
      if (currentMessage) {
        message += ` ${currentMessage.message}`
      }
    } else if (task.state.current.type === 'completed') {
      message += ` in ${task.state.current.duration}ms`
      if (task.state.current.cached) {
        message += ' [CACHED]'
      }
    } else if (task.state.current.type === 'error') {
      message += ` ${task.state.current.errorMessage}`
    }

    count += printWithTruncate(env, message)
  }

  moveCursor(env.stdout, 0, -1 * count)
}

function countChar(message: string, char: string): number {
  let result = 0
  for (let i = 0; i < message.length; i++) {
    if (message[i] === char) {
      result++
    }
  }
  return result
}

function printWithTruncate(env: Environment, message: string): number {
  let lineCount = 0
  let index = 0
  do {
    const newLineCount = countChar(message, '\n')
    env.stdout.write(`${message.substring(index, index + env.stdoutColumns)}\n`)
    index += env.stdoutColumns
    lineCount++
    lineCount += newLineCount
  } while (index < message.length)
  return lineCount
}

export function hideCursor(env: Environment): void {
  env.stdout.write('\x1B[?25l')
}

export function showCursor(env: Environment): void {
  env.stdout.write('\x1B[?25h')
}
