import { WorkRuntime } from '../runtime/runtime'
import { TaskState } from '../executer/scheduler/task-state'

// An aggregate runs nothing, so it touches nothing: no pid or state file in its
// directory (on a server that is a checkout it doesn't trust), no outputs.
export function aggregateWorkRuntime(): WorkRuntime<TaskState> {
  return {
    async initialize(): Promise<void> {
      // nothing to prepare
    },
    async remove(): Promise<void> {
      // it has no outputs of its own
    },
    async execute(): Promise<void> {
      // its state stays running, and executeWorkTask completes it
    },
    async stop(): Promise<void> {
      // nothing is running
    },
    async archive(): Promise<void> {
      // never pushed, see pushToBackend
    },
    async restore(): Promise<void> {
      // never a hit, see checkCacheState
    },
    async currentStateKey(): Promise<string | null> {
      return null
    },
  }
}
