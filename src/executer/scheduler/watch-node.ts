import { SchedulerState } from './scheduler-state'
import { EventBus } from '../event-bus'
import { WorkNode } from '../../planner/work-node'
import { Environment } from '../environment'
import { getWorkNodeCacheStats, hasStatsChanged } from '../../optimizer/get-work-node-cache-stats'
import { Debouncer } from '../../utils/debouncer'
import { join } from 'path'
import { listenOnAbort } from '../../utils/abort-event'
import { resetNode } from './reset-node-action'

export async function watchNode(state: SchedulerState, eventBus: EventBus, node: WorkNode, environment: Environment) {
  if (node.src.length === 0) {
    return
  }

  let currentState = await getWorkNodeCacheStats(node, environment)

  const debouncer = new Debouncer(async () => {
    if (environment.abortCtrl.signal.aborted) {
      return
    }

    const newStats = await getWorkNodeCacheStats(node, environment)
    const hasChanged = await hasStatsChanged(node, currentState, newStats, state.cacheMethod)
    if (!hasChanged) {
      return
    }
    currentState = newStats

    node.status.write('debug', `source changed for node ${node.name}, restart process`)

    await resetNode(state, environment, eventBus, node)
  }, 100)

  for (const src of node.src) {
    node.status.write('debug', `watch ${src.absolutePath} source`)
    const watcher = environment.file.watch(src.absolutePath, async (fileName) => {
      const absoluteFileName = join(src.absolutePath, fileName)

      if (src.matcher(absoluteFileName, node.cwd)) {
        node.status.write('debug', `source ${absoluteFileName} change for watched task ${node.name}`)
        debouncer.bounce()
      }
    })
    listenOnAbort(environment.abortCtrl.signal, () => {
      watcher.close()
      debouncer.clear()
    })
  }
}
