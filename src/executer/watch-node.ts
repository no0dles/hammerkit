import { Environment } from './environment'
import { getWorkNodeCacheStats, getCacheState } from '../optimizer/get-work-node-cache-stats'
import { Debouncer } from '../utils/debouncer'
import { FileWatcher } from '../file/file-context'
import { join } from 'path'
import { waitOnAbort } from '../utils/abort-event'
import { State } from './state'
import { Process } from './process'
import { ProcessManager } from './process-manager'
import { WorkItem } from '../planner/work-item'
import { WorkNode } from '../planner/work-node'

export function watchNode(
  node: WorkItem<WorkNode>,
  state: State,
  processManager: ProcessManager,
  environment: Environment
): Process {
  return async (abort: AbortController) => {
    let currentState = await getWorkNodeCacheStats(node.data, environment)

    const debouncer = new Debouncer(async () => {
      if (environment.abortCtrl.signal.aborted) {
        return
      }

      const newStats = await getWorkNodeCacheStats(node.data, environment)
      const currentFileState = getCacheState(
        node.status,
        { name: node.name, caching: node.data.caching ?? state.current.cacheMethod },
        currentState,
        newStats
      )
      currentState = newStats

      const currentNodeState = state.current.node[node.id]
      if (currentNodeState.stateKey === currentFileState.stateKey) {
        return
      }

      node.status.write('debug', `source changed for node ${node.name}, restart process`)
      state.resetNode({
        type: 'pending',
        node: node,
        itemId: node.id,
        stateKey: currentFileState.stateKey,
      })
    }, 100)

    const fileWatchers: FileWatcher[] = []
    const sources: string[] = []

    for (const src of node.data.src) {
      node.status.write('debug', `watch ${src.absolutePath} source`)

      const watcher = environment.file.watch(src.absolutePath, async (fileName) => {
        const absoluteFileName = join(src.absolutePath, fileName)

        if (src.matcher(absoluteFileName, node.data.cwd)) {
          node.status.write('debug', `source ${absoluteFileName} change for watched task ${node.name}`)
          debouncer.bounce()
        }
      })

      sources.push(src.absolutePath)
      fileWatchers.push(watcher)
    }

    await waitOnAbort(abort.signal)

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
