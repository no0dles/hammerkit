import { EmitHandle, EmitListener, emitter, Emitter } from '../utils/emitter'
import { getEnvironmentConfig } from '../utils/environment-config'
import { isVerbose } from '../log'
import { Writable } from 'stream'
import { WorkItem } from './work-item'
import { WorkService } from './work-service'
import { WorkNode } from './work-node'

export type WorkNodeConsoleLogLevel = 'debug' | 'info' | 'warn' | 'error'
export type ConsoleType = 'stdout' | 'stderr'

const StatusBufferMax = getEnvironmentConfig('STATUS_BUFFER_LIMIT', 300)
const ConsoleBufferMax = getEnvironmentConfig('CONSOLE_BUFFER_LIMIT', 30)

export interface ConsoleMessage {
  type: 'console'
  console: ConsoleType
  message: string
  date: Date
  context: LogContext
}

export interface StatusMessage {
  type: 'status'
  level: WorkNodeConsoleLogLevel
  message: string
  date: Date
  context: LogContext
}

export type Message = ConsoleMessage | StatusMessage

// TODO replace with WorkItem
export type LogContext =
  | {
      type: 'task' | 'service'
      name: string
      id: string
    }
  | {
      type: 'cli'
      id: 'general'
      name: 'hammerkit'
    }

export function logContext(id: string, type: 'task' | 'service', node: WorkService | WorkNode): LogContext {
  return {
    type,
    name: node.name,
    id: id,
  }
}

export interface StatusConsole extends Emitter<Message> {
  from(id: string, node: WorkService | WorkNode): StatusScopedConsole
  context(ctx: LogContext): StatusScopedConsole

  read(): Generator<StatusMessage>
}

export interface StatusScopedConsole {
  write(level: WorkNodeConsoleLogLevel, message: string): void

  console(type: ConsoleType, message: string): void

  read(): Generator<StatusMessage>

  current(): StatusMessage | null
  currentLog(): ConsoleMessage | null
  logs(): Generator<ConsoleMessage>
}

class BufferContext<T> {
  private scopedBuffer: { [key: string]: T[] } = {}
  private buffer: T[] = []

  constructor(private limit: number) {}

  add(id: string, data: T) {
    this.buffer.push(data)
    if (id in this.scopedBuffer) {
      const scopedBuffer = this.scopedBuffer[id]
      scopedBuffer.push(data)
      if (scopedBuffer.length > this.limit) {
        const removedBuffer = this.buffer.splice(0, 1)[0]
        const bufferIndex = this.buffer.indexOf(removedBuffer)
        if (bufferIndex >= 0) {
          this.buffer.splice(bufferIndex, 1)
        }
      }
    } else {
      this.scopedBuffer[id] = [data]
    }
  }

  current(id: string): T | null {
    if (!(id in this.scopedBuffer)) {
      return null
    }
    const value = this.scopedBuffer[id]
    return value[value.length - 1]
  }

  get(id?: string): T[] {
    if (id) {
      return this.scopedBuffer[id] ?? []
    } else {
      return this.buffer
    }
  }
}

export function statusConsole(writable: Writable): StatusConsole {
  const statusBuffer = new BufferContext<StatusMessage>(StatusBufferMax)
  const consoleBuffer = new BufferContext<ConsoleMessage>(ConsoleBufferMax)

  const emit = emitter<Message>()

  function addMessage(context: LogContext, message: Message) {
    emit.emit(message)
    writable.write(JSON.stringify({ context, message }) + '\n')
    if (message.type === 'console') {
      consoleBuffer.add(context.id, message)
    } else if (isVerbose || message.level !== 'debug') {
      statusBuffer.add(context.id, message)
    }
  }

  return {
    from(id: string, item: WorkService | WorkNode): StatusScopedConsole {
      if (item.type === 'kubernetes-service' || item.type === 'container-service') {
        return this.context(logContext(id, 'service', item))
      } else {
        return this.context(logContext(id, 'task', item))
      }
    },
    context(context: LogContext): StatusScopedConsole {
      return {
        currentLog() {
          return consoleBuffer.current(context.id)
        },
        current() {
          return statusBuffer.current(context.id)
        },
        *logs(): Generator<ConsoleMessage> {
          for (const log of consoleBuffer.get(context.id)) {
            yield log
          }
        },
        *read(): Generator<StatusMessage> {
          for (const log of statusBuffer.get(context.id)) {
            yield log
          }
        },
        console(type: ConsoleType, message: string) {
          addMessage(context, {
            type: 'console',
            console: type,
            message,
            date: new Date(),
            context,
          })
        },
        write(level: WorkNodeConsoleLogLevel, message: string) {
          addMessage(context, {
            type: 'status',
            message,
            context,
            level,
            date: new Date(),
          })
        },
      }
    },
    on(listener: EmitListener<Message>): EmitHandle {
      return emit.on(listener)
    },
    *read(): Generator<StatusMessage> {
      for (const message of statusBuffer.get()) {
        yield message
      }
    },
  }
}
