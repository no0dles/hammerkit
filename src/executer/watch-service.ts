import { Environment } from './environment'
import { getCacheState, getWorkCacheStats } from '../optimizer/get-work-node-cache-stats'
import { Debouncer } from '../utils/debouncer'
import { FileWatcher } from '../file/file-context'
import { waitOnAbort } from '../utils/abort-event'
import { Process } from './process'
import { ProcessManager } from './process-manager'
import { WorkItemState } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'
import { CliExecOptions } from '../cli'
import { ServiceState } from './scheduler/service-state'

export function watchService(
  item: WorkItemState<ContainerWorkService, ServiceState>,
  processManager: ProcessManager,
  environment: Environment,
  options: CliExecOptions
): Process {
  const service = item.data
  return async (abort: AbortController) => {
    let currentState = await getWorkCacheStats(service, environment)

    const debouncer = new Debouncer(async () => {
      if (environment.abortCtrl.signal.aborted) {
        return
      }

      const newStats = await getWorkCacheStats(service, environment)
      const currentFileState = getCacheState(
        item.status,
        { name: service.name, caching: options.cacheDefault },
        currentState,
        newStats
      )
      currentState = newStats

      if (item.state.current.stateKey === currentFileState.stateKey) {
        return
      }

      if (item.state.current.type === 'running') {
        item.status.write('debug', `source changed for service ${service.name}, restart process`)
        // await item.state.restart() // TODO
      } else if (item.state.current.type === 'error') {
        // TODO other states
        item.state.set({
          type: 'pending',
          stateKey: currentFileState.stateKey,
        })
      }
    }, 100)

    const fileWatchers: FileWatcher[] = []

    for (const src of service.src) {
      item.status.write('debug', `watch ${src.absolutePath} src`)

      const watcher = environment.file.watch(src.absolutePath, async (fileName) => {
        item.status.write('debug', `source ${fileName} change for watched service ${service.name}`)
        debouncer.bounce()
      })

      fileWatchers.push(watcher)
    }

    await waitOnAbort(abort.signal)

    debouncer.clear()
    for (const watcher of fileWatchers) {
      watcher.close()
    }

    return {
      type: 'service-watch-canceled',
      service,
    }
  }
}
