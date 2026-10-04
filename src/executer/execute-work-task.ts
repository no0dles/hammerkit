import { WorkItemState } from '../planner/work-item'
import { WorkTask } from '../planner/work-task'
import { Environment } from './environment'
import { CliExecOptions } from '../cli'
import { getDuration } from './states'
import { TaskState } from './scheduler/task-state'
import { AbortError, checkForAbort } from './abort'
import { getErrorMessage } from '../log'
import { awaitCompletedDependencies, awaitDependentNeed, awaitRunningNeeds } from './await-completed-dependencies'
import { watchLoop } from './watch-loop'
import { CacheState } from './scheduler/enqueue-next'
import { describeCause, explainTask } from '../cache/explain'
import { archiveTaskEntry } from './archive-task-entry'
import { formatDuration } from '../utils/units'
import { listenOnAbort } from '../utils/abort-event'

async function pushToBackend(
  work: WorkItemState<WorkTask, TaskState>,
  environment: Environment,
  cacheState: CacheState,
  options: CliExecOptions
) {
  const { resolved, stateKey, provable } = cacheState
  if (resolved.method === 'none' || !provable) {
    return
  }
  if (options.cacheReadOnly) {
    work.status.write('debug', `${work.name} not pushed to cache "${resolved.name}" (read-only)`)
    return
  }
  try {
    const cacheDir = await archiveTaskEntry(work, environment)
    await resolved.backend.push(work.id(), stateKey, cacheDir, environment)
    work.status.write('info', `${work.name} pushed to cache "${resolved.name}" (${resolved.backend.type})`)
  } catch (e) {
    work.status.write('warn', `${work.name} failed to push to cache "${resolved.name}": ${getErrorMessage(e)}`)
  }
}

// An abort signal that follows `parent` and additionally fires after `timeout`
// ms, so a task deadline reuses the runtimes' existing abort/cleanup path.
function withDeadline(parent: AbortSignal, timeout: number | null) {
  const controller = new AbortController()
  let expired = false
  const parentListener = listenOnAbort(parent, () => controller.abort())
  const timer =
    timeout === null
      ? null
      : setTimeout(() => {
          expired = true
          controller.abort()
        }, timeout)
  return {
    signal: controller.signal,
    expired: () => expired,
    clear() {
      if (timer) {
        clearTimeout(timer)
      }
      parentListener.close()
    },
  }
}

// A task without cmds only groups its dependencies (`ci: { deps: [test, build] }`).
// Having no src of its own it is never a cache hit, so its dependencies are
// always checked and their outputs restored. When every one of them was a hit,
// nothing ran: report the group as cached too. Reporting only, the cache
// decision is untouched.
function onlyGroupsCacheHits(work: WorkItemState<WorkTask, TaskState>): boolean {
  return (
    work.data.cmds.length === 0 &&
    work.deps.every((dep) => dep.state.current.type === 'completed' && dep.state.current.cached)
  )
}

export async function executeWorkTask(
  work: WorkItemState<WorkTask, TaskState>,
  environment: Environment,
  options: CliExecOptions,
  // when set, the task was not requested and only runs if one of these tasks
  // depending on it misses the cache (see executeWorkTree)
  dependents: WorkItemState<WorkTask, TaskState>[] | null = null
) {
  try {
    if (dependents) {
      const needed = await awaitDependentNeed(dependents, environment.abortCtrl.signal)
      if (!needed) {
        work.status.write('debug', `${work.name} skipped, every task depending on it was a cache hit`)
        work.state.set({ type: 'completed', cached: false, skipped: true, duration: 0, stateKey: '' })
        return
      }
    }

    work.state.set({
      type: 'starting',
      started: new Date(),
      stateKey: null,
    })

    await watchLoop(work, environment, options, async (cacheState, abort) => {
      const started = new Date()

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

      // Only a cache miss is `ready`: needed services start on `ready`, so a
      // cached task never starts the services it would have needed.
      work.state.set({
        type: 'ready',
        stateKey: cacheState.stateKey,
        started: new Date(),
      })

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

        const timeout = work.data.timeout ?? options.timeout
        const deadline = withDeadline(abort, timeout)
        try {
          await work.runtime.execute(environment, {
            cache: cacheState,
            abort: deadline.signal,
            stateKey: cacheState.stateKey,
            state: work.state,
            daemon: options.daemon,
            publishPorts: false,
            waitForReady: true,
          })
        } finally {
          deadline.clear()
        }

        if (deadline.expired() && timeout !== null) {
          // the runtime saw an abort and cleaned up; report it as a failure
          // (never a cancellation) and stop the run like any failing task
          work.state.set({
            type: 'error',
            stateKey: cacheState.stateKey,
            errorMessage: `timed out after ${formatDuration(timeout)}`,
          })
          if (!options.watch) {
            environment.abortCtrl.abort()
          }
          return
        }

        checkForAbort(abort)

        if (work.state.current.type === 'running') {
          work.status.write('debug', 'completed for state key ' + cacheState.stateKey)
          await pushToBackend(work, environment, cacheState, options)
          const cached = onlyGroupsCacheHits(work)
          work.state.set({
            stateKey: cacheState.stateKey,
            type: 'completed',
            cached,
            duration: getDuration(started),
            missCauses: cached ? undefined : missCauses,
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
      // Stop the run like a failing command does: dependents wait for this task
      // to complete, which it now never will.
      if (!options.watch) {
        environment.abortCtrl.abort()
      }
    }
  }
}
