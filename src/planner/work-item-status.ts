import { EmitHandle, EmitListener, emitter, Emitter } from '../utils/emitter'
import { getEnvironmentConfig } from '../utils/environment-config'
import { isVerbose } from '../log'
import { Writable } from 'stream'
import { WorkService } from './work-service'
import { WorkTask } from './work-task'
import { BufferContext } from '../utils/buffer-context'
import { createSecretRegistry, SecretRegistry } from '../utils/redact'
import type { PodLogCursor } from '../kubernetes/follow-pod-logs'

export type WorkItemLogLevel = 'debug' | 'info' | 'warn' | 'error'
export type ConsoleType = 'stdout' | 'stderr'

const StatusBufferMax = getEnvironmentConfig('STATUS_BUFFER_LIMIT', 300)
const ConsoleBufferMax = getEnvironmentConfig('CONSOLE_BUFFER_LIMIT', 30)

export interface ConsoleMessage {
  type: 'console'
  console: ConsoleType
  message: string
  date: Date
  context: LogContext
  // a line of the log of a pod: where that log got to with it
  cursor?: PodLogCursor
}

export interface StatusMessage {
  type: 'status'
  level: WorkItemLogLevel
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
    }
  | {
      type: 'cli'
      name: 'hammerkit'
    }

export function logContext(type: 'task' | 'service', item: WorkService | WorkTask): LogContext {
  return {
    type,
    name: item.name,
  }
}
// TODO cleanup
export interface StatusConsole extends Emitter<Message> {
  from(item: WorkService | WorkTask): StatusScopedConsole
  context(ctx: LogContext): StatusScopedConsole

  read(): Generator<StatusMessage>
}

// TODO cleanup
export interface StatusScopedConsole {
  write(level: WorkItemLogLevel, message: string): void

  console(type: ConsoleType, message: string, cursor?: PodLogCursor): void

  read(): Generator<StatusMessage>

  current(): StatusMessage | null
  currentLog(): ConsoleMessage | null
  logs(): Generator<ConsoleMessage>
}

// `secrets` is the registry of the run (its Environment) whose output this console shows.
export function statusConsole(writable: Writable, secrets: SecretRegistry = createSecretRegistry()): StatusConsole {
  const statusBuffer = new BufferContext<StatusMessage>(StatusBufferMax)
  const consoleBuffer = new BufferContext<ConsoleMessage>(ConsoleBufferMax)

  const emit = emitter<Message>()

  function addMessage(context: LogContext, unredacted: Message) {
    const message = { ...unredacted, message: secrets.redact(unredacted.message) }
    emit.emit(message)
    // the cursor of a line is for the server that resumes a run, not for its readers
    const written = message.type === 'console' && message.cursor ? { ...message, cursor: undefined } : message
    writable.write(JSON.stringify({ context, message: written }) + '\n')
    if (message.type === 'console') {
      consoleBuffer.add(context.name, message)
    } else if (isVerbose || message.level !== 'debug') {
      statusBuffer.add(context.name, message)
    }
  }

  return {
    from(item: WorkService | WorkTask): StatusScopedConsole {
      if (item.type === 'kubernetes-service' || item.type === 'container-service') {
        return this.context(logContext('service', item))
      } else {
        return this.context(logContext('task', item))
      }
    },
    context(context: LogContext): StatusScopedConsole {
      return {
        currentLog() {
          return consoleBuffer.current(context.name)
        },
        current() {
          return statusBuffer.current(context.name)
        },
        *logs(): Generator<ConsoleMessage> {
          for (const log of consoleBuffer.get(context.name)) {
            yield log
          }
        },
        *read(): Generator<StatusMessage> {
          for (const log of statusBuffer.get(context.name)) {
            yield log
          }
        },
        console(type: ConsoleType, message: string, cursor?: PodLogCursor) {
          addMessage(context, {
            type: 'console',
            console: type,
            message,
            date: new Date(),
            context,
            ...(cursor ? { cursor } : {}),
          })
        },
        write(level: WorkItemLogLevel, message: string) {
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
