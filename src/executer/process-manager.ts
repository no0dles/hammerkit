import { listenOnAbort } from '../utils/abort-event'
import { ProcessItem } from './process-item'
import { Process } from './process'
import { ProcessListener, ProcessListenerEvent } from './process-listener'
import { Environment } from './environment'
import { getErrorMessage } from '../log'
import { WorkItem } from '../planner/work-item'
import { WorkNode } from '../planner/work-node'
import { WorkService } from '../planner/work-service'

interface PendingProcess {
  abortController: AbortController
  process: Process
  item: WorkItem<WorkService | WorkNode>
  processName: string
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

  abort(id: string): void {
    this.pendingProcesses = this.pendingProcesses.filter((p) => p.item.id !== id)
    const processes = this.processes.filter((p) => p.id === id)
    for (const process of processes) {
      process.abortController.abort()
    }
  }

  background(item: WorkItem<WorkNode | WorkService>, process: Process, processName: string): AbortController {
    const abortController = new AbortController()
    listenOnAbort(this.env.abortCtrl.signal, () => {
      abortController.abort()
    })

    this.startProcess({ process, processName, item, abortController })

    return abortController
  }

  task(item: WorkItem<WorkNode | WorkService>, process: Process): AbortController {
    const abortController = new AbortController()
    listenOnAbort(this.env.abortCtrl.signal, () => {
      abortController.abort()
    })

    const hasFreeWorker = this.workerLimit === 0 || this.workerLimit > this.processes.length
    if (hasFreeWorker) {
      const hasBlockingProcess = this.processes.some((p) => p.id === item.id)
      if (hasBlockingProcess) {
        this.abort(item.id)
        this.pendingProcesses.push({ item, process, processName: 'task', abortController })
      } else {
        this.startProcess({ process, item, processName: 'task', abortController })
      }
    } else {
      this.pendingProcesses.push({ item, process, processName: 'task', abortController })
    }

    return abortController
  }

  private enqueuePendingProcesses() {
    const nextProcess = this.pendingProcesses[0]
    if (nextProcess) {
      const hasBlockingProcess = this.processes.some((p) => p.id === nextProcess.item.id)
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
      id: pendingProcess.item.id,
      started,
      abortController: pendingProcess.abortController,
      promise: pendingProcess
        .process(pendingProcess.abortController, started)
        .catch((err) => {
          pendingProcess.item.status.write('error', getErrorMessage(err))
        })
        .finally(() => {
          const index = this.processes.indexOf(item)
          this.processes.splice(index, 1)
          this.notifyListeners({ item: pendingProcess.item, type: 'ended' })
          this.enqueuePendingProcesses()
        }),
    }

    this.processes.push(item)
    this.notifyListeners({ item: pendingProcess.item, processName: pendingProcess.processName, type: 'started' })
  }

  private notifyListeners(evt: ProcessListenerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(
          evt,
          this.processes,
          this.pendingProcesses.map((p) => ({ item: p.item }))
        )
      } catch (e) {
        evt.item.status.write('error', getErrorMessage(e))
      }
    }
  }
}
