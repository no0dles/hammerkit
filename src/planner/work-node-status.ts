import { EmitHandle, EmitListener, emitter, Emitter } from '../utils/emitter'

export type WorkNodeConsoleLogLevel = 'debug' | 'info' | 'warn' | 'error'
export type ConsoleType = 'stdout' | 'stderr'
const ConsoleBufferMax = 100
const StatusBufferMax = 200

export interface ConsoleMessage {
  type: ConsoleType
  message: string
  date: Date
}

export interface StatusMessage {
  level: WorkNodeConsoleLogLevel
  message: string
  date: Date
}

export interface StatusConsole extends Emitter<StatusMessage> {
  write(level: WorkNodeConsoleLogLevel, message: string): void

  read(): Promise<StatusMessage[]>
}

export interface LogConsole extends Emitter<ConsoleMessage> {
  current: ConsoleMessage | null
  recent: ConsoleMessage[]

  write(type: ConsoleType, message: string): void

  read(): Promise<ConsoleMessage[]>
}

export function statusConsole(): StatusConsole {
  const recent: StatusMessage[] = []

  const emit = emitter<StatusMessage>()

  return {
    write(level: WorkNodeConsoleLogLevel, message: string) {
      const log: StatusMessage = { message, level, date: new Date() }
      emit.emit(log)
      recent.push(log)
      if (recent.length > StatusBufferMax) {
        recent.splice(0, 1)
      }
    },
    on(listener: EmitListener<StatusMessage>): EmitHandle {
      return emit.on(listener)
    },
    read(): Promise<StatusMessage[]> {
      return Promise.resolve(recent)
    },
  }
}

export function nodeConsole(): LogConsole {
  let current: ConsoleMessage | null = null
  const recent: ConsoleMessage[] = []

  const emit = emitter<ConsoleMessage>()

  return {
    read(): Promise<ConsoleMessage[]> {
      return Promise.resolve(recent)
    },

    on(listener: EmitListener<ConsoleMessage>): EmitHandle {
      return emit.on(listener)
    },

    write(type: ConsoleType, message: string) {
      const log: ConsoleMessage = { type, message, date: new Date() }
      current = log
      emit.emit(log)
      recent.push(log)
      if (recent.length > ConsoleBufferMax) {
        recent.splice(0, 1)
      }
    },

    get recent() {
      return recent
    },

    get current() {
      return current
    },
  }
}
