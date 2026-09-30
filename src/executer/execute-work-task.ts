import { WorkItemState } from '../planner/work-item'
import { WorkTask } from '../planner/work-task'
import { Environment } from './environment'
import { CliExecOptions } from '../cli'
import { getDuration } from './states'
import { TaskState } from './scheduler/task-state'
import { AbortError, checkForAbort } from './abort'
import { getErrorMessage } from '../log'
import { awaitCompletedDependencies, awaitRunningNeeds } from './await-completed-dependencies'
import { watchLoop } from './watch-loop'
import { getCacheDirectory } from '../optimizer/get-cache-directory'
import { writeCacheMetadata } from './cache-metadata'
import { getWorkCacheStats } from '../optimizer/get-work-cache-stats'
import { getWorkTaskCacheDescription } from '../optimizer/work-task-cache-description'
import { CacheState } from './scheduler/enqueue-next'
import { describeCause, explainTask } from '../cache/explain'
import { getWorkInstanceId } from '../planner/work-instance-id'

async function pushToBackend(
  work: WorkItemState<WorkTask, TaskState>,
  environment: Environment,
  cacheState: CacheState,
  options: CliExecOptions
) {
  const { resolved, stateKey } = cacheState
  if (resolved.method === 'none') {
    return
  }
  if (options.cacheReadOnly) {
    work.status.write('debug', `${work.name} not pushed to cache "${resolved.name}" (read-only)`)
    return
  }
  try {
    const cacheDir = getCacheDirectory(getWorkInstanceId(work))
    const stats = await getWorkCacheStats(work.data, environment)
    await writeCacheMetadata(environment, work, stats, getWorkTaskCacheDescription(work.data))
    await work.runtime.archive(environment, cacheDir)
    await resolved.backend.push(work.id(), stateKey, cacheDir, environment)
    work.status.write('info', `${work.name} pushed to cache "${resolved.name}" (${resolved.backend.type})`)
  } catch (e) {
    work.status.write('warn', `${work.name} failed to push to cache "${resolved.name}": ${getErrorMessage(e)}`)
  }
}

export async function executeWorkTask(
  work: WorkItemState<WorkTask, TaskState>,
  environment: Environment,
  options: CliExecOptions
) {
  try {
    work.state.set({
      type: 'starting',
      started: new Date(),
      stateKey: null,
    })

    await watchLoop(work, environment, options, async (cacheState, abort) => {
      const started = new Date()

      work.state.set({
        type: 'ready',
        stateKey: cacheState.stateKey,
        started: new Date(),
      })

      if (cacheState.cached) {
        work.status.write('debug', 'completed for cached state key ' + cacheState.stateKey)
        work.state.set({
          type: 'completed',
          cached: true,
          stateKey: cacheState.stateKey,
          duration: getDuration(started),
        })
        return
      }

      // Cache miss: under the explain flag, report why this task is rebuilding,
      // reusing the cache-explain engine. Captured BEFORE execution overwrites
      // the last-resolved record, then carried onto the completed state so the
      // build summary can show the cause column. Reporting only.
      let missCauses: string[] | undefined
      if (options.explain) {
        const explanation = await explainTask(work, options.cacheDefault, environment)
        missCauses = explanation.causes.map(describeCause)
        for (const cause of missCauses) {
          work.status.write('info', `cache miss: ${cause}`)
        }
      }

      await awaitCompletedDependencies(work, work.deps, abort)
      await awaitRunningNeeds(
        work,
        work.needs.map((n) => n.service),
        abort
      )

      await options.processManager.task(work, async () => {
        work.state.set({
          type: 'running',
          stateKey: cacheState.stateKey,
          started,
        })

        await work.runtime.execute(environment, {
          cache: cacheState,
          abort,
          stateKey: cacheState.stateKey,
          state: work.state,
          daemon: options.daemon,
        })

        checkForAbort(abort)

        if (work.state.current.type === 'running') {
          work.status.write('debug', 'completed for state key ' + cacheState.stateKey)
          await pushToBackend(work, environment, cacheState, options)
          work.state.set({
            stateKey: cacheState.stateKey,
            type: 'completed',
            cached: false,
            duration: getDuration(started),
            missCauses,
          })
        } else {
          if (!options.watch) {
            environment.abortCtrl.abort()
          }
        }
      })
    })
  } catch (e) {
    if (e instanceof AbortError) {
      if (work.state.current.type !== 'completed') {
        work.state.set({
          type: 'canceled',
          stateKey: null,
        })
      }
    } else {
      work.state.set({
        type: 'error',
        errorMessage: getErrorMessage(e),
        stateKey: null,
      })
    }
  }
}
