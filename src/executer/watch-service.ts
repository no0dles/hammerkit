import { Environment } from './environment'
import { ContainerWorkService } from '../planner/work-service'
import { getServiceNodeCacheStats, hasStatsChanged } from '../optimizer/get-work-node-cache-stats'
import { Debouncer } from '../utils/debouncer'
import { FileWatcher } from '../file/file-context'
import { join } from 'path'
import { waitOnAbort } from '../utils/abort-event'
import { State } from './state'
import { Process } from './process'

export function watchService(service: ContainerWorkService, state: State, environment: Environment): Process {
  return async (abort: AbortSignal) => {
    let currentState = await getServiceNodeCacheStats(service, environment)

    const status = environment.status.service(service)
    const debouncer = new Debouncer(async () => {
      if (environment.abortCtrl.signal.aborted) {
        return
      }

      const newStats = await getServiceNodeCacheStats(service, environment)
      const hasChanged = await hasStatsChanged(
        status,
        { name: service.name, caching: state.current.cacheMethod },
        currentState,
        newStats
      )
      if (!hasChanged) {
        return
      }
      currentState = newStats

      status.write('debug', `source changed for service ${service.name}, restart process`)

      const serviceState = state.current.service[service.id]
      if (serviceState.type === 'running') {
        serviceState.abortController.abort() // TODO await stop
      }
      state.patchService({
        type: 'pending',
        service,
      })
    }, 100)

    const fileWatchers: FileWatcher[] = []
    const mounts: string[] = []

    for (const mount of service.mounts) {
      status.write('debug', `watch ${mount.localPath} mount`)

      const watcher = environment.file.watch(mount.localPath, async (fileName) => {
        const absoluteFileName = join(mount.localPath, fileName)
        status.write('debug', `source ${absoluteFileName} change for watched service ${service.name}`)
        debouncer.bounce()
      })

      mounts.push(mount.localPath)
      fileWatchers.push(watcher)
    }

    await waitOnAbort(abort)

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
