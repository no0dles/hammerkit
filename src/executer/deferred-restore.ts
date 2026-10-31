import { WorkItem, WorkItemState } from '../planner/work-item'
import { WorkTask } from '../planner/work-task'
import { WorkService } from '../planner/work-service'
import { TaskState } from './scheduler/task-state'

// `run --no-restore`: a cache hit is only looked up (`has`), not downloaded.
// Its outputs are fetched here, once, when a task or service that runs a
// command depends on it. Keyed by the item, so a run restores each hit at most
// once however many items wait on it.
interface DeferredRestore {
  run: () => Promise<void>
  promise: Promise<void> | null
}

const deferred = new WeakMap<WorkItemState<WorkTask, TaskState>, DeferredRestore>()

export function deferRestore(item: WorkItemState<WorkTask, TaskState>, run: () => Promise<void>): void {
  deferred.set(item, { run, promise: null })
}

// Restore every given item that was a hit without its outputs, in parallel.
export async function restoreDeferred(
  work: WorkItem<WorkTask | WorkService>,
  items: WorkItemState<WorkTask, TaskState>[]
): Promise<void> {
  await Promise.all(
    items.map((item) => {
      const entry = deferred.get(item)
      if (!entry) {
        return Promise.resolve()
      }
      if (!entry.promise) {
        work.status.write('debug', `restore ${item.name} from cache, ${work.name} needs its outputs`)
        entry.promise = entry.run()
      }
      return entry.promise
    })
  )
}
