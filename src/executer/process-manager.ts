import { listenOnAbort } from '../utils/abort-event'
import { ProcessItem } from './process-item'
import { Process } from './process'
import { ProcessListener, ProcessListenerEvent } from './process-listener'
import { LogContext } from '../planner/work-node-status'
import { Environment } from './environment'
import { getErrorMessage } from '../log'

// TODO limit worker count, add queuing
export class ProcessManager {
  private processes: ProcessItem[] = []
  private listeners: ProcessListener[] = []

  constructor(private env: Environment) {}

  on(listener: ProcessListener) {
    this.listeners.push(listener)
  }

  onComplete(): Promise<void> {
    if (this.processes.length === 0) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.listeners.push((evt, processes) => {
        if (processes.length === 0) {
          resolve()
        }
      })
    })
  }

  task(ctx: LogContext, process: Process): AbortController {
    const abortController = new AbortController()
    listenOnAbort(this.env.abortCtrl.signal, () => {
      abortController.abort()
    })

    const started = new Date()
    const item: ProcessItem = {
      context: ctx,
      started,
      promise: process(abortController.signal, started)
        .catch((err) => {
          this.env.status.context(ctx).write('error', getErrorMessage(err))
        })
        .finally(() => {
          const index = this.processes.indexOf(item)
          this.processes.splice(index, 1)
          this.notifyListeners({ process: item, type: 'ended' })
        }),
    }

    this.processes.push(item)
    this.notifyListeners({ process: item, type: 'started' })

    return abortController
  }

  private notifyListeners(evt: ProcessListenerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(evt, this.processes)
      } catch (e) {
        this.env.status.context(evt.process.context).write('error', getErrorMessage(e))
      }
    }
  }
}
