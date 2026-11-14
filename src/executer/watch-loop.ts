import { watchStateKey } from './watch-state-key'
import { State } from './state'
import { WorkItemState } from '../planner/work-item'
import { WorkService } from '../planner/work-service'
import { WorkTask } from '../planner/work-task'
import { Environment } from './environment'
import { CliExecOptions } from '../cli'
import { listenOnAbort } from '../utils/abort-event'
import { untilChanged } from './state-resolver'
import { AbortError, checkForAbort } from './abort'
import { ServiceState } from './scheduler/service-state'
import { TaskState } from './scheduler/task-state'
import { CacheState, checkCacheState } from './scheduler/enqueue-next'
import { getExecutionStateKeys, StateKeyMemo } from './scheduler/state-key'

export interface CurrentRun {
  abortController: AbortController
  cacheState: CacheState
}

// Whether an item is rechecked when its files change: not in daemon mode, and not for a
// container service that watches its own files (`continuous`); a kubernetes-service and a
// task have no such field
export function isWatchMode(
  work: WorkItemState<WorkService, ServiceState> | WorkItemState<WorkTask, TaskState>,
  options: CliExecOptions
): boolean {
  const continuous = 'continuous' in work.data ? work.data.continuous : false
  return !!options.watch && !options.daemon && !continuous
}

// The keys of the execution to share, see getExecutionStateKeys: none in watch mode, where a
// key is computed again because files changed
export function getSharedStateKeys(
  work: WorkItemState<WorkService, ServiceState> | WorkItemState<WorkTask, TaskState>,
  options: CliExecOptions
): StateKeyMemo | undefined {
  return isWatchMode(work, options) ? undefined : getExecutionStateKeys(options)
}

export async function watchLoop(
  work: WorkItemState<WorkService, ServiceState> | WorkItemState<WorkTask, TaskState>,
  environment: Environment,
  options: CliExecOptions,
  factory: (cacheState: CacheState, abortSignal: AbortSignal, stop: () => void) => Promise<void>
) {
  const watchMode = isWatchMode(work, options)

  const currentStats = await checkCacheState(work, options.cacheDefault, environment, {
    watch: watchMode,
    restore: options.restore,
    memo: getSharedStateKeys(work, options),
  })
  checkForAbort(environment.abortCtrl.signal)

  const watchState = watchMode
    ? watchStateKey(work, currentStats, environment, options)
    : new State<CacheState>(currentStats)

  let currentRun: CurrentRun = {
    abortController: new AbortController(),
    cacheState: watchState.current,
  }

  if (watchMode) {
    watchState.on('state-key', (cacheState) => {
      work.status.write('debug', 'sources changed, abort current run')
      currentRun.abortController.abort()
      currentRun = {
        abortController: new AbortController(),
        cacheState,
      }
    })
  }

  const abortListener = listenOnAbort(environment.abortCtrl.signal, () => {
    currentRun.abortController.abort()
    watchState.close()
  })

  do {
    const currentState = watchState.current
    try {
      await factory(currentState, currentRun.abortController.signal, () => {
        currentRun.abortController.abort()
      })
    } catch (e) {
      if (e instanceof AbortError) {
        work.state.set({
          type: 'canceled',
          stateKey: currentState.stateKey,
        })
      } else {
        throw e
      }
    }

    if (!watchMode) {
      break
    }

    if (currentState.stateKey !== watchState.current.stateKey) {
      continue
    }

    await untilChanged('watch-source-change', watchState, environment.abortCtrl.signal)
    work.status.write('debug', 'sources changed')
  } while (watchMode)

  abortListener.close()
}
