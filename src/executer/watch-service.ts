import { Environment } from './environment'
import { Process } from './emitter'
import { HammerkitEvent, ServiceWatchCanceledEvent } from './events'
import { WorkService } from '../planner/work-service'
import { getServiceNodeCacheStats, hasStatsChanged } from '../optimizer/get-work-node-cache-stats'
import { Debouncer } from '../utils/debouncer'
import { FileWatcher } from '../file/file-context'
import { join } from 'path'
import { waitOnAbort } from '../utils/abort-event'

export function watchService(
  service: WorkService,
  environment: Environment
): Process<ServiceWatchCanceledEvent, HammerkitEvent> {
  return async (abort: AbortSignal, hub) => {
    let currentState = await getServiceNodeCacheStats(service, environment)

    const debouncer = new Debouncer(async () => {
      if (environment.abortCtrl.signal.aborted) {
        return
      }

      const newStats = await getServiceNodeCacheStats(service, environment)
      const hasChanged = await hasStatsChanged(service, currentState, newStats)
      if (!hasChanged) {
        return
      }
      currentState = newStats

      service.status.write('debug', `source changed for service ${service.name}, restart process`)

      hub.emit({
        type: 'service-watch-reset',
        service,
      })
    }, 100)

    const fileWatchers: FileWatcher[] = []
    const mounts: string[] = []

    for (const mount of service.mounts) {
      service.status.write('debug', `watch ${mount.localPath} mount`)

      const watcher = environment.file.watch(mount.localPath, async (fileName) => {
        const absoluteFileName = join(mount.localPath, fileName)
        service.status.write('debug', `source ${absoluteFileName} change for watched service ${service.name}`)
        debouncer.bounce()
      })

      mounts.push(mount.localPath)
      fileWatchers.push(watcher)
    }

    hub.emit({
      type: 'service-watch-start',
      service,
      mounts,
    })

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
