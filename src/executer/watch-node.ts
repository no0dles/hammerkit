import { Environment } from './environment'
import { getCacheState, getWorkCacheStats } from '../optimizer/get-work-node-cache-stats'
import { Debouncer } from '../utils/debouncer'
import { FileWatcher } from '../file/file-context'
import { join } from 'path'
import { waitOnAbort } from '../utils/abort-event'
import { Process } from './process'
import { ProcessManager } from './process-manager'
import { WorkItemState } from '../planner/work-item'
import { WorkNode } from '../planner/work-node'
import { CliExecOptions } from '../cli'
import { NodeState } from './scheduler/node-state'

export function watchNode(
  node: WorkItemState<WorkNode, NodeState>,
  processManager: ProcessManager,
  environment: Environment,
  options: CliExecOptions
): Process {
  return async (abort: AbortController) => {
    let currentState = await getWorkCacheStats(node.data, environment)

    const debouncer = new Debouncer(async () => {
      if (environment.abortCtrl.signal.aborted) {
        return
      }

      const newStats = await getWorkCacheStats(node.data, environment)
      const currentFileState = getCacheState(
        node.status,
        { name: node.name, caching: node.data.caching ?? options.cacheDefault },
        currentState,
        newStats
      )
      currentState = newStats

      if (node.state.current.stateKey === currentFileState.stateKey) {
        return
      }

      node.status.write('debug', `source changed for node ${node.name}, restart process`)
      node.state.set({
        type: 'pending',
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
