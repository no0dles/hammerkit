import { WorkItem, WorkItemState } from '../planner/work-item'
import { WorkTask } from '../planner/work-task'
import { WorkService } from '../planner/work-service'
import { TaskState } from './scheduler/task-state'
import { checkForAbort } from './abort'

// `run --no-restore`: a cache hit is only looked up (`has`), not downloaded.
// Its outputs are fetched here, once, when a task or service that runs a
// command depends on it.
interface DeferredRestore {
  run: () => Promise<void>
  promise: Promise<void> | null
}

// Keyed by the item's state, which every run replaces (resetWorkTree): a hit
// deferred in one run of a Cli is never restored in a later one, over outputs
// that run built.
const deferred = new WeakMap<object, DeferredRestore>()

export function deferRestore(item: WorkItemState<WorkTask, TaskState>, run: () => Promise<void>): void {
  deferred.set(item.state, { run, promise: null })
}

// Every cache check starts from scratch: a key that changed since a hit was
// deferred must not restore the old entry.
export function clearDeferredRestore(item: WorkItemState<WorkTask | WorkService, unknown>): void {
  deferred.delete(item.state)
}

// Restore every given item that was a hit without its outputs, in parallel,
// each at most once however many items wait on it.
export async function restoreDeferred(
  work: WorkItem<WorkTask | WorkService>,
  items: WorkItemState<WorkTask, TaskState>[],
  abort: AbortSignal
): Promise<void> {
  await Promise.all(
    items.map((item) => {
      const entry = deferred.get(item.state)
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
  checkForAbort(abort)
}
