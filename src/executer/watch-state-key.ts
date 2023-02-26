import { WorkItem } from '../planner/work-item'
import { WorkNode } from '../planner/work-node'
import { WorkService } from '../planner/work-service'
import { Environment } from './environment'
import { getStateKey, getWorkCacheStats } from '../optimizer/get-work-node-cache-stats'
import { Debouncer } from '../utils/debouncer'
import { FileWatcher } from '../file/file-context'
import { join } from 'path'
import { waitOnAbort } from '../utils/abort-event'
import { CliExecOptions } from '../cli'
import { State } from './state'

export function watchStateKey(
  item: WorkItem<WorkNode | WorkService>,
  stateKey: string,
  environment: Environment,
  options: CliExecOptions
): State<string> {
  const state = new State<string>(stateKey)
  const debouncer = new Debouncer(async () => {
    if (environment.abortCtrl.signal.aborted) {
      return
    }

    const newStats = await getWorkCacheStats(item.data, environment)
    const stateKey = getStateKey(newStats, item.data.caching ?? options.cacheDefault)
    if (state.current !== stateKey) {
      state.set(stateKey)
    }
  }, 100)

  const fileWatchers: FileWatcher[] = []

  for (const src of item.data.src) {
    if (src.inherited) {
      continue
    }

    item.status.write('debug', `watch ${src.absolutePath} source`)

    const watcher = environment.file.watch(src.absolutePath, async (fileName) => {
      const absoluteFileName = join(src.absolutePath, fileName)

      if (src.matcher(absoluteFileName, item.data.cwd)) {
        item.status.write('debug', `source ${absoluteFileName} change for watched task ${item.name}`)
        debouncer.bounce()
      }
    })

    fileWatchers.push(watcher)
  }

  waitOnAbort(environment.abortCtrl.signal).then(() => {
    for (const fileWatcher of fileWatchers) {
      fileWatcher.close()
    }

    debouncer.clear()
  })

  return state
}
