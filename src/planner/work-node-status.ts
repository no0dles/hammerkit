import { WorkNode } from './work-node'
import { Defer } from '../defer'
import { isVerbose } from '../log'
import { EmitHandle, EmitListener, emitter, Emitter } from '../emit'

export type WorkNodeConsoleLogLevel = 'debug' | 'info' | 'warn' | 'error'
export type WorkNodeConsoleLogType = 'process' | 'internal'

export interface WorkNodeConsoleLog {
  level: WorkNodeConsoleLogLevel
  type: WorkNodeConsoleLogType
  message: string
  date: Date
}

export interface WorkNodeConsole extends Emitter<WorkNodeConsoleLog> {
  current: WorkNodeConsoleLog | null

  write(type: WorkNodeConsoleLogType, level: WorkNodeConsoleLogLevel, message: string): void

  read(): Promise<WorkNodeConsoleLog[]>
}

export function nodeConsole(): WorkNodeConsole {
  let current: WorkNodeConsoleLog | null = null
  const logs: WorkNodeConsoleLog[] = []

  const emit = emitter<WorkNodeConsoleLog>()

  return {
    read(): Promise<WorkNodeConsoleLog[]> {
      return Promise.resolve(logs)
    },

    on(listener: EmitListener<WorkNodeConsoleLog>): EmitHandle {
      return emit.on(listener)
    },

    write(type: WorkNodeConsoleLogType, level: WorkNodeConsoleLogLevel, message: string) {
      const log: WorkNodeConsoleLog = { level, type, message, date: new Date() }
      if (isVerbose || level !== 'debug') {
        current = log
      }
      emit.emit(log)
      logs.push(log)
    },

    get current() {
      return current
    },
  }
}

export interface WorkNodeStatus {
  pendingDependencies: { [id: string]: WorkNode }
  completedDependencies: { [id: string]: WorkNode }
  state: WorkNodeState
  defer: Defer<void>
  console: WorkNodeConsole
}

export type WorkNodeState =
  | WorkNodePendingState
  | WorkNodeRunningState
  | WorkNodeCompletedState
  | WorkNodeFailedState
  | WorkNodeAbortedState
  | WorkNodeCancelState

export interface WorkNodePendingState {
  type: 'pending'
}

export interface WorkNodeCancelState {
  type: 'cancel'
}

export interface WorkNodeAbortedState {
  type: 'aborted'
}

export interface WorkNodeRunningState {
  type: 'running'
  started: Date
  cancelDefer: Defer<void>
}

export interface WorkNodeCompletedState {
  type: 'completed'
  duration: number
  ended: Date
}

export interface WorkNodeFailedState {
  type: 'failed'
  duration: number
  error: Error
  ended: Date
}
