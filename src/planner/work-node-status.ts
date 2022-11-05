import { EmitHandle, EmitListener, emitter, Emitter } from '../utils/emitter'
import { WorkService } from './work-service'
import { isWorkNode, WorkNode } from './work-node'
import { getEnvironmentConfig } from '../utils/environment-config'

export type WorkNodeConsoleLogLevel = 'debug' | 'info' | 'warn' | 'error'
export type ConsoleType = 'stdout' | 'stderr'

const StatusBufferMax = getEnvironmentConfig('STATUS_BUFFER_LIMIT', 300)

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

export interface LogContext {
  type: 'task' | 'service'
  name: string
  id: string
}

export function logContext(type: 'task' | 'service', node: WorkNode | WorkService): LogContext {
  return {
    type,
    name: node.name,
    id: node.id,
  }
}

export interface StatusConsole extends Emitter<Message> {
  service(service: WorkService): StatusScopedConsole

  task(task: WorkNode): StatusScopedConsole
  from(node: WorkNode | WorkService): StatusScopedConsole
  context(ctx: LogContext): StatusScopedConsole

  read(): Generator<Message>
}

export interface StatusScopedConsole {
  write(level: WorkNodeConsoleLogLevel, message: string): void

  console(type: ConsoleType, message: string): void

  read(): Generator<Message>

  current(): Message | null
}

export function statusConsole(): StatusConsole {
  const buffer: Message[] = []
  const contextBuffer: { [key: string]: { buffer: Message[] } } = {}

  const emit = emitter<Message>()

  function addMessage(context: LogContext, message: Message) {
    buffer.push(message)
    emit.emit(message)
    if (context.id in contextBuffer) {
      const scopedBuffer = contextBuffer[context.id]
      scopedBuffer.buffer.push(message)
      if (scopedBuffer.buffer.length > StatusBufferMax) {
        const removedBuffer = buffer.splice(0, 1)[0]
        const bufferIndex = buffer.indexOf(removedBuffer)
        if (bufferIndex >= 0) {
          buffer.splice(bufferIndex, 1)
        }
      }
    } else {
      contextBuffer[context.id] = { buffer: [message] }
    }
  }

  return {
    task(task: WorkNode): StatusScopedConsole {
      return this.context(logContext('task', task))
    },
    service(service: WorkService): StatusScopedConsole {
      return this.context(logContext('service', service))
    },
    from(node: WorkNode | WorkService): StatusScopedConsole {
      if (isWorkNode(node)) {
        return this.task(node)
      } else {
        return this.service(node)
      }
    },
    context(context: LogContext): StatusScopedConsole {
      return {
        current() {
          if (!(context.id in contextBuffer)) {
            return null
          }
          const value = contextBuffer[context.id]
          return value.buffer[value.buffer.length - 1]
        },
        *read(): Generator<Message> {
          for (const log of contextBuffer[context.id]?.buffer || []) {
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
    *read(): Generator<Message> {
      for (const message of buffer) {
        yield message
      }
    },
  }
}
