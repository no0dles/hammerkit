import { ProcessItem } from './process-item'
import { getErrorMessage } from '../log'
import { WorkItem } from '../planner/work-item'
import { WorkTask } from '../planner/work-task'
import { WorkService } from '../planner/work-service'
import { ResourceAmount, ResourceBudget } from './resource-budget'

interface PendingProcess {
  factory: () => Promise<void>
  item: WorkItem<WorkService | WorkTask>
  resolve: () => void
  reject: (err: unknown) => void
}

export class ProcessManager {
  private processes: ProcessItem[] = []
  private pendingProcesses: PendingProcess[] = []

  // With a budget a task also starts only once its requests fit next to what
  // runs already; one starts regardless when nothing else runs, so a run
  // whose services alone fill the budget, or a task bigger than it, still
  // makes progress.
  constructor(
    private workerLimit: number,
    private budget: ResourceBudget | null = null
  ) {}

  task(item: WorkItem<WorkTask>, factory: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.budget) {
        this.pendingProcesses.push({ item, factory, resolve, reject })
        this.startFitting()
        return
      }
      const hasFreeWorker = this.workerLimit === 0 || this.workerLimit > this.processes.length
      if (hasFreeWorker) {
        this.startProcess({ factory, item, resolve, reject })
      } else {
        this.pendingProcesses.push({ item, factory, resolve, reject })
      }
    })
  }

  // A running service holds its requests until it ends; it never waits, the
  // tasks needing it do.
  service(item: WorkItem<WorkService>): () => void {
    const budget = this.budget
    if (!budget) {
      return () => undefined
    }
    const requests = budget.requestsOf(item)
    budget.acquire(requests)
    let released = false
    return () => {
      if (!released) {
        released = true
        budget.release(requests)
        this.startFitting()
      }
    }
  }

  private enqueuePendingProcesses() {
    if (this.budget) {
      this.startFitting()
      return
    }

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

  // In order, every pending task that fits; a later, smaller one may start
  // while an earlier one waits for room.
  private startFitting() {
    for (const pending of [...this.pendingProcesses]) {
      if (this.workerLimit !== 0 && this.processes.length >= this.workerLimit) {
        return
      }
      if (this.processes.some((p) => p.id === pending.item.name)) {
        continue
      }
      const requests = this.budget!.requestsOf(pending.item)
      if (this.processes.length > 0 && !this.budget!.fits(requests)) {
        continue
      }
      this.pendingProcesses.splice(this.pendingProcesses.indexOf(pending), 1)
      this.startProcess(pending, requests)
    }
  }

  private startProcess(pendingProcess: PendingProcess, requests: ResourceAmount | null = null) {
    if (requests) {
      this.budget?.acquire(requests)
    }
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
          if (requests) {
            this.budget?.release(requests)
          }
          this.enqueuePendingProcesses()
        }),
    }

    this.processes.push(item)
  }
}
