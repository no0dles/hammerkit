import { listenOnAbort } from '../utils/abort-event'
import { ProcessItem } from './process-item'
import { Process } from './process'
import { ProcessListener, ProcessListenerEvent } from './process-listener'
import { LogContext } from '../planner/work-node-status'
import { Environment } from './environment'
import { getErrorMessage } from '../log'

interface PendingProcess {
  abortController: AbortController
  process: Process
  context: LogContext
}

export class ProcessManager {
  private processes: ProcessItem[] = []
  private pendingProcesses: PendingProcess[] = []
  private listeners: ProcessListener[] = []

  constructor(private env: Environment, private workerLimit: number) {}

  on(listener: ProcessListener) {
    this.listeners.push(listener)
  }

  onComplete(): Promise<void> {
    if (this.processes.length === 0 && this.pendingProcesses.length === 0) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.listeners.push((evt, processes, pending) => {
        if (processes.length === 0 && pending.length === 0) {
          resolve()
        }
      })
    })
  }

  abort(context: LogContext): void {
    this.pendingProcesses = this.pendingProcesses.filter((p) => p.context.id !== context.id)
    const processes = this.processes.filter((p) => p.context.id === context.id)
    for (const process of processes) {
      process.abortController.abort()
    }
  }

  background(context: LogContext, process: Process): AbortController {
    const abortController = new AbortController()
    listenOnAbort(this.env.abortCtrl.signal, () => {
      abortController.abort()
    })

    this.startProcess({ process, context, abortController })

    return abortController
  }

  task(context: LogContext, process: Process): AbortController {
    const abortController = new AbortController()
    listenOnAbort(this.env.abortCtrl.signal, () => {
      abortController.abort()
    })

    const hasFreeWorker = this.workerLimit === 0 || this.workerLimit > this.processes.length
    if (hasFreeWorker) {
      const hasBlockingProcess = this.processes.some((p) => p.context.id === context.id)
      if (hasBlockingProcess) {
        this.abort(context)
        this.pendingProcesses.push({ context, process, abortController })
      } else {
        this.startProcess({ process, context, abortController })
      }
    } else {
      this.pendingProcesses.push({ context, process, abortController })
    }

    return abortController
  }

  private enqueuePendingProcesses() {
    const nextProcess = this.pendingProcesses[0]
    if (nextProcess) {
      const hasBlockingProcess = this.processes.some((p) => p.context.id === nextProcess.context.id)
      if (hasBlockingProcess) {
        return
      }
    }

    const pendingProcess = this.pendingProcesses.shift()
    if (pendingProcess) {
      this.startProcess(pendingProcess)
    }
  }

  private startProcess(pendingProcess: PendingProcess) {
    const started = new Date()
    const item: ProcessItem = {
      context: pendingProcess.context,
      started,
      abortController: pendingProcess.abortController,
      promise: pendingProcess
        .process(pendingProcess.abortController, started)
        .catch((err) => {
          this.env.status.context(pendingProcess.context).write('error', getErrorMessage(err))
        })
        .finally(() => {
          const index = this.processes.indexOf(item)
          this.processes.splice(index, 1)
          this.notifyListeners({ context: item.context, type: 'ended' })
          this.enqueuePendingProcesses()
        }),
    }

    this.processes.push(item)
    this.notifyListeners({ context: item.context, type: 'started' })
  }

  private notifyListeners(evt: ProcessListenerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(
          evt,
          this.processes,
          this.pendingProcesses.map((p) => ({ context: p.context }))
        )
      } catch (e) {
        this.env.status.context(evt.context).write('error', getErrorMessage(e))
      }
    }
  }
}
