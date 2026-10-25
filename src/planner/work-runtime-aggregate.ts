import { WorkRuntime } from '../runtime/runtime'
import { TaskState } from '../executer/scheduler/task-state'

// An aggregate runs nothing, so it touches nothing: no pid or state file in its
// directory (on a server that is a checkout it doesn't trust), no outputs. Its
// state stays running, and executeWorkTask completes it.
export function aggregateWorkRuntime(): WorkRuntime<TaskState> {
  return {
    async initialize(): Promise<void> {},
    async remove(): Promise<void> {},
    async execute(): Promise<void> {},
    async stop(): Promise<void> {},
    async archive(): Promise<void> {},
    async restore(): Promise<void> {},
    // never a hit itself, see checkCacheState
    async currentStateKey(): Promise<string | null> {
      return null
    },
  }
}
