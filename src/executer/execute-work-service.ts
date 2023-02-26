import { isContainerWorkServiceItem, isKubernetesWorkServiceItem, WorkItemState } from '../planner/work-item'
import { WorkService } from '../planner/work-service'
import { ServiceState } from './scheduler/service-state'
import { Environment } from './environment'
import { CliExecOptions } from '../cli'
import {
  awaitCompletedDependencies,
  awaitNoRequirements,
  awaitRequirement,
  awaitRunningNeeds,
} from './await-completed-dependencies'
import { getStateKey, getWorkCacheStats } from '../optimizer/get-work-node-cache-stats'
import { watchStateKey } from './watch-state-key'
import { State } from './state'
import { listenOnAbort } from '../utils/abort-event'
import { AbortError, checkForAbort } from './abort'
import { getServiceContainers } from './get-service-containers'
import { dockerService } from './docker-service'
import { kubernetesService } from './kubernetes-service'
import { getErrorMessage } from '../log'
import { removeContainer } from '../docker/remove-container'
import { watchLoop } from './watch-loop'

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

    await watchLoop(work, environment, options, async (cacheState, abort, stop) => {
      await awaitCompletedDependencies(work, work.deps, abort)

      work.state.set({
        type: 'ready',
        stateKey: cacheState.stateKey,
      })

      await awaitRunningNeeds(
        work,
        work.needs.map((n) => n.service),
        abort
      )

      if (options.type === 'execute') {
        awaitNoRequirements(work, abort).then(() => {
          stop()
        })
      }

      const serviceContainers = getServiceContainers(work.needs)
      if (isContainerWorkServiceItem(work)) {
        await dockerService(work, cacheState.stateKey, serviceContainers, environment, options, abort)
      } else if (isKubernetesWorkServiceItem(work)) {
        await kubernetesService(work, cacheState.stateKey, abort)
      }
    })
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
