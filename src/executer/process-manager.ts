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

// How urgent a waiting task is, higher first: see getTaskPriority.
export type ProcessPriority = (item: WorkItem<WorkService | WorkTask>) => number

export class ProcessManager {
  private processes: ProcessItem[] = []
  private pendingProcesses: PendingProcess[] = []
  private pickScheduled = false
  // the running tasks whose pod the quota of the namespace refuses now
  private refused = new Set<WorkItem<WorkService | WorkTask>>()

  // With a budget a task also starts only once its requests fit next to what
  // runs already; one starts regardless when nothing else runs, so a run
  // whose services alone fill the budget, or a task bigger than it, still
  // makes progress.
  // With a priority, the waiting task that is most urgent takes a free place,
  // else the one that waits longest. Places are then given out a moment after a
  // task arrives or one ends, so the tasks that the same event made ready (the
  // dependents of a task that completed) compete for them together.
  constructor(
    private workerLimit: number,
    private budget: ResourceBudget | null = null,
    private priority: ProcessPriority | null = null
  ) {}

  task(item: WorkItem<WorkTask>, factory: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.priority) {
        this.pendingProcesses.push({ item, factory, resolve, reject })
        this.schedulePick()
        return
      }
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
        if (this.priority) {
          this.schedulePick()
        } else {
          this.startFitting()
        }
      }
    }
  }

  // A running task tells whether the quota refuses its pod now. While it is refused, the
  // tasks less urgent than it wait, so the room that frees goes to it and not to a pod of
  // theirs; without a priority nothing changes.
  quotaRefused(item: WorkItem<WorkService | WorkTask>, refused: boolean): void {
    if (refused) {
      this.refused.add(item)
    } else if (this.refused.delete(item) && this.priority) {
      this.schedulePick()
    }
  }

  private schedulePick() {
    if (this.pickScheduled) {
      return
    }
    this.pickScheduled = true
    setImmediate(() => {
      this.pickScheduled = false
      if (this.budget) {
        this.startFitting()
      } else {
        this.startByPriority()
      }
    })
  }

  // The waiting tasks that may start now, most urgent first; of equal ones, the one
  // waiting longest. While the quota refuses a running task's pod, only those more urgent
  // than it.
  private startable(): PendingProcess[] {
    const priority = this.priority
    if (!priority) {
      return [...this.pendingProcesses]
    }
    const floor = this.refused.size > 0 ? Math.max(...[...this.refused].map((item) => priority(item))) : null
    return this.pendingProcesses
      .map((pending, index) => ({ pending, index, rank: priority(pending.item) }))
      .filter(({ rank }) => floor === null || rank > floor)
      .sort((a, b) => b.rank - a.rank || a.index - b.index)
      .map(({ pending }) => pending)
  }

  private startByPriority() {
    for (const pending of this.startable()) {
      if (this.workerLimit !== 0 && this.processes.length >= this.workerLimit) {
        return
      }
      if (this.processes.some((p) => p.id === pending.item.name)) {
        continue
      }
      this.pendingProcesses.splice(this.pendingProcesses.indexOf(pending), 1)
      this.startProcess(pending)
    }
  }

  private enqueuePendingProcesses() {
    if (this.priority) {
      this.schedulePick()
      return
    }
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

  // In order (by priority when there is one), every pending task that fits; a
  // later, smaller one may start while an earlier one waits for room.
  private startFitting() {
    for (const pending of this.startable()) {
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
          this.refused.delete(pendingProcess.item)
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
