import { WorkNode } from '../planner/work-node'
import { Environment } from './environment'
import { Process } from './emitter'
import { HammerkitEvent, NodeWatchCanceledEvent } from './events'
import { getWorkNodeCacheStats, hasStatsChanged } from '../optimizer/get-work-node-cache-stats'
import { Debouncer } from '../utils/debouncer'
import { FileWatcher } from '../file/file-context'
import { join } from 'path'
import { waitOnAbort } from '../utils/abort-event'

export function watchNode(node: WorkNode, environment: Environment): Process<NodeWatchCanceledEvent, HammerkitEvent> {
  return async (abort: AbortSignal, hub) => {
    let currentState = await getWorkNodeCacheStats(node, environment)

    const debouncer = new Debouncer(async () => {
      if (environment.abortCtrl.signal.aborted) {
        return
      }

      const newStats = await getWorkNodeCacheStats(node, environment)
      const hasChanged = await hasStatsChanged(node, currentState, newStats)
      if (!hasChanged) {
        return
      }
      currentState = newStats

      node.status.write('debug', `source changed for node ${node.name}, restart process`)

      hub.emit({
        type: 'node-watch-reset',
        node,
      })
    }, 100)

    const fileWatchers: FileWatcher[] = []
    const sources: string[] = []

    for (const src of node.src) {
      node.status.write('debug', `watch ${src.absolutePath} source`)

      const watcher = environment.file.watch(src.absolutePath, async (fileName) => {
        const absoluteFileName = join(src.absolutePath, fileName)

        if (src.matcher(absoluteFileName, node.cwd)) {
          node.status.write('debug', `source ${absoluteFileName} change for watched task ${node.name}`)
          debouncer.bounce()
        }
      })

      sources.push(src.absolutePath)
      fileWatchers.push(watcher)
    }

    hub.emit({
      type: 'node-watch-start',
      node,
      sources,
    })

    await waitOnAbort(abort)

    debouncer.clear()
    for (const watcher of fileWatchers) {
      watcher.close()
    }

    return {
      type: 'node-watch-canceled',
      node,
    }
  }
}
