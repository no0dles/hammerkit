import {
  isContainerWorkServiceItem,
  isContainerWorkTaskItem,
  isKubernetesWorkServiceItem,
  isLocalWorkTaskItem,
  WorkItemState,
} from '../planner/work-item'
import { WorkNode } from '../planner/work-node'
import { Environment } from './environment'
import { CliExecOptions } from '../cli'
import { checkCacheState } from './scheduler/enqueue-next'
import { getDuration } from './states'
import { NodeState } from './scheduler/node-state'
import { writeWorkNodeCache } from '../optimizer/write-work-node-cache'
import { AbortError, checkForAbort, createSubController } from './abort'
import { getErrorMessage } from '../log'
import { watchStateKey } from './watch-state-key'
import {
  awaitCompletedDependencies,
  awaitNoRequirements,
  awaitRequirement,
  awaitRunningNeeds,
} from './await-completed-dependencies'
import { dockerNode } from './docker-node'
import { getServiceContainers } from './get-service-containers'
import { localNode } from './local-node'
import { WorkTree } from '../planner/work-tree'
import { iterateWorkNodes, iterateWorkServices } from '../planner/utils/plan-work-nodes'
import { WorkService } from '../planner/work-service'
import { ServiceState } from './scheduler/service-state'
import { dockerService } from './docker-service'
import { kubernetesService } from './kubernetes-service'
import { getStateKey, getWorkCacheStats } from '../optimizer/get-work-node-cache-stats'
import { State } from './state'
import { untilChanged } from './state-resolver'
import { removeContainer } from '../docker/remove-container'
import { listenOnAbort } from '../utils/abort-event'

export async function executeWorkTree(work: WorkTree, environment: Environment, options: CliExecOptions) {
  const nodePromises: Promise<void>[] = []

  for (const node of iterateWorkNodes(work)) {
    if (node.state.current.type === 'pending') {
      nodePromises.push(executeWorkTask(node, environment, options))
    }
  }

  for (const service of iterateWorkServices(work)) {
    if (options.type === 'down') {
      if (service.state.current.type === 'running') {
        nodePromises.push(stopService(service, environment))
      }
    } else if (service.state.current.type === 'pending') {
      nodePromises.push(executeWorkService(service, environment, options))
    }
  }

  await Promise.all(nodePromises)
}

export async function stopService(work: WorkItemState<WorkService, ServiceState>, environment: Environment) {
  if (work.state.current.type === 'running' && !!work.state.current.remote) {
    await removeContainer(environment.docker.getContainer(work.state.current.remote.containerId))
  }
}

export async function executeWorkService(
  work: WorkItemState<WorkService, ServiceState>,
  environment: Environment,
  options: CliExecOptions
) {
  try {
    if (options.type === 'execute') {
      await awaitRequirement(work, environment.abortCtrl.signal)
    }

    work.state.set({
      type: 'starting',
      stateKey: null,
    })
    // TODO await processManager for process limit

    const currentStats = await getWorkCacheStats(work.data, environment)
    const stateKey = await getStateKey(currentStats, work.data.caching ?? options.cacheDefault)
    const started = new Date()

    let currentStateKey = stateKey
    let required = true
    let abortController = new AbortController()
    const watchState =
      options.watch && !options.daemon
        ? watchStateKey(work, stateKey, environment, options)
        : new State<string>(stateKey)

    watchState.on('state-key', (stateKey) => {
      abortController.abort()
      abortController = new AbortController()
      currentStateKey = stateKey
    })

    listenOnAbort(environment.abortCtrl.signal, () => {
      abortController.abort()
    })

    if (options.type === 'execute') {
      awaitNoRequirements(work, environment.abortCtrl.signal).then(() => {
        abortController.abort()
        required = false
      })
    }

    do {
      await awaitCompletedDependencies(work, work.deps, environment.abortCtrl.signal)

      work.state.set({
        type: 'ready',
        stateKey: watchState.current,
      })

      await awaitRunningNeeds(
        work,
        work.needs.map((n) => n.service),
        environment.abortCtrl.signal
      )
      checkForAbort(environment.abortCtrl.signal)

      const serviceContainers = getServiceContainers(work.needs)

      try {
        if (isContainerWorkServiceItem(work)) {
          await dockerService(work, stateKey, serviceContainers, environment, options)(abortController, started)
        } else if (isKubernetesWorkServiceItem(work)) {
          await kubernetesService(work, stateKey)(abortController, started)
        }
      } catch (e) {
        if (e instanceof AbortError) {
          work.state.set({
            type: 'canceled',
            stateKey: null,
          })
        }
      }

      if (!options.daemon && required && currentStateKey === watchState.current && options.watch) {
        await untilChanged('watch-source-change', watchState, environment.abortCtrl.signal)
      }
    } while (!options.daemon && required && (currentStateKey !== watchState.current || options.watch))
  } catch (e) {
    if (e instanceof AbortError) {
      work.state.set({
        type: 'canceled',
        stateKey: null,
      })
    } else {
      work.state.set({
        type: 'error',
        errorMessage: getErrorMessage(e),
        stateKey: null,
      })
    }
  }
}

export async function executeWorkTask(
  work: WorkItemState<WorkNode, NodeState>,
  environment: Environment,
  options: CliExecOptions
) {
  try {
    const started = new Date()

    work.state.set({
      type: 'starting',
      started: new Date(),
      stateKey: null,
    })

    const cacheState = await checkCacheState(work, options.cacheDefault, environment)
    checkForAbort(environment.abortCtrl.signal)

    work.state.set({
      type: 'ready',
      stateKey: cacheState.stateKey,
      started,
    })

    let currentStateKey = cacheState.stateKey
    let abortController = createSubController(environment.abortCtrl.signal)
    const watchState =
      options.watch && !options.daemon
        ? watchStateKey(work, cacheState.stateKey, environment, options)
        : new State<string>(cacheState.stateKey)

    watchState.on('state-key', (stateKey) => {
      if (currentStateKey != stateKey) {
        abortController.abort()
        abortController = createSubController(environment.abortCtrl.signal)
      }
    })

    do {
      currentStateKey = watchState.current
      if (cacheState.cached) {
        work.status.write('debug', 'completed for cached state key ' + cacheState.stateKey)
        work.state.set({
          type: 'completed',
          cached: true,
          stateKey: cacheState.stateKey,
          duration: getDuration(started),
        })
      } else {
        await awaitCompletedDependencies(work, work.deps, environment.abortCtrl.signal)
        await awaitRunningNeeds(
          work,
          work.needs.map((n) => n.service),
          environment.abortCtrl.signal
        )
        checkForAbort(environment.abortCtrl.signal)

        // TODO await processManager for process limit

        await options.processManager.task(work, async () => {
          currentStateKey = watchState.current
          work.state.set({
            type: 'running',
            stateKey: currentStateKey,
            started,
          })

          try {
            if (isContainerWorkTaskItem(work)) {
              const serviceContainers = getServiceContainers(work.needs)
              await dockerNode(work, currentStateKey, serviceContainers, environment)(abortController, started)
            } else if (isLocalWorkTaskItem(work)) {
              await localNode(work, currentStateKey, environment)(abortController, started)
            }
            checkForAbort(environment.abortCtrl.signal)

            if (work.state.current.type === 'running') {
              await writeWorkNodeCache(work, environment)

              work.status.write('debug', 'completed for state key ' + currentStateKey)
              work.state.set({
                stateKey: currentStateKey,
                type: 'completed',
                cached: false,
                duration: getDuration(started),
              })
            } else {
              if (!options.watch) {
                environment.abortCtrl.abort()
              }
            }
          } catch (e) {
            if (e instanceof AbortError) {
              work.state.set({
                type: 'canceled',
                stateKey: null,
              })
            } else {
              throw e
            }
          }
        })
      }

      if (currentStateKey === watchState.current && options.watch) {
        await untilChanged('watch-source-change', watchState, environment.abortCtrl.signal)
      }
    } while (currentStateKey !== watchState.current && options.watch)
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
