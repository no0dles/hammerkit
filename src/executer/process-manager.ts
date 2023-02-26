import { listenOnAbort } from '../utils/abort-event'
import { ProcessItem } from './process-item'
import { getErrorMessage } from '../log'
import { WorkItem } from '../planner/work-item'
import { WorkNode } from '../planner/work-node'
import { WorkService } from '../planner/work-service'

interface PendingProcess {
  abortController: AbortController
  factory: () => Promise<void>
  item: WorkItem<WorkService | WorkNode>
  resolve: () => void
  reject: (err: unknown) => void
}

export class ProcessManager {
  private processes: ProcessItem[] = []
  private pendingProcesses: PendingProcess[] = []

  constructor(private abortSignal: AbortSignal, private workerLimit: number) {}

  task(item: WorkItem<WorkNode>, factory: () => Promise<void>): Promise<void> {
    const abortController = new AbortController()
    listenOnAbort(this.abortSignal, () => {
      abortController.abort()
    })

    return new Promise<void>((resolve, reject) => {
      const hasFreeWorker = this.workerLimit === 0 || this.workerLimit > this.processes.length
      if (hasFreeWorker) {
        this.startProcess({ factory, item, abortController, resolve, reject })
      } else {
        this.pendingProcesses.push({ item, factory, abortController, resolve, reject })
      }
    })
  }

  private enqueuePendingProcesses() {
    const nextProcess = this.pendingProcesses[0]
    if (nextProcess) {
      const hasBlockingProcess = this.processes.some((p) => p.id === nextProcess.item.name)
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
    const item: ProcessItem = {
      id: pendingProcess.item.name,
      promise: pendingProcess
        .factory()
        .then(() => {
          pendingProcess.resolve()
        })
        .catch((err) => {
          pendingProcess.item.status.write('error', getErrorMessage(err))
          pendingProcess.reject(err)
        })
        .finally(() => {
          const index = this.processes.indexOf(item)
          this.processes.splice(index, 1)
          this.enqueuePendingProcesses()
        }),
    }

    this.processes.push(item)
  }
}
