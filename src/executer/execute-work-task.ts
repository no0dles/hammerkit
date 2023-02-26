import { isContainerWorkTaskItem, isLocalWorkTaskItem, WorkItemState } from '../planner/work-item'
import { WorkNode } from '../planner/work-node'
import { Environment } from './environment'
import { CliExecOptions } from '../cli'
import { getDuration } from './states'
import { NodeState } from './scheduler/node-state'
import { writeWorkNodeCache } from '../optimizer/write-work-node-cache'
import { AbortError, checkForAbort } from './abort'
import { getErrorMessage } from '../log'
import { awaitCompletedDependencies, awaitRunningNeeds } from './await-completed-dependencies'
import { dockerNode } from './docker-node'
import { getServiceContainers } from './get-service-containers'
import { localNode } from './local-node'
import { watchLoop } from './watch-loop'

export async function executeWorkTask(
  work: WorkItemState<WorkNode, NodeState>,
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

        if (isContainerWorkTaskItem(work)) {
          const serviceContainers = getServiceContainers(work.needs)
          await dockerNode(work, cacheState.stateKey, serviceContainers, environment, abort)
        } else if (isLocalWorkTaskItem(work)) {
          await localNode(work, cacheState.stateKey, environment, abort)
        }
        checkForAbort(abort)

        if (work.state.current.type === 'running') {
          await writeWorkNodeCache(work, environment)

          work.status.write('debug', 'completed for state key ' + cacheState.stateKey)
          work.state.set({
            stateKey: cacheState.stateKey,
            type: 'completed',
            cached: false,
            duration: getDuration(started),
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
