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

export interface CurrentRun {
  abortController: AbortController
  cacheState: CacheState
}

export async function watchLoop(
  work: WorkItemState<WorkService, ServiceState> | WorkItemState<WorkTask, TaskState>,
  environment: Environment,
  options: CliExecOptions,
  factory: (cacheState: CacheState, abortSignal: AbortSignal, stop: () => void) => Promise<void>
) {
  const currentStats = await checkCacheState(work, work.data.caching ?? options.cacheDefault, environment)
  checkForAbort(environment.abortCtrl.signal)

  const watchMode = options.watch && !options.daemon

  const watchState = watchMode
    ? watchStateKey(work, currentStats, environment, options)
    : new State<CacheState>(currentStats)

  let stopped = false
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
  })

  do {
    const currentState = watchState.current
    try {
      await factory(currentState, currentRun.abortController.signal, () => {
        currentRun.abortController.abort()
        stopped = true
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
