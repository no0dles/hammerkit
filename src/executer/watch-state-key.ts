import { WorkItem } from '../planner/work-item'
import { WorkNode } from '../planner/work-node'
import { WorkService } from '../planner/work-service'
import { Environment } from './environment'
import { Debouncer } from '../utils/debouncer'
import { FileWatcher } from '../file/file-context'
import { join } from 'path'
import { waitOnAbort } from '../utils/abort-event'
import { CliExecOptions } from '../cli'
import { State } from './state'
import { CacheState, checkCacheState } from './scheduler/enqueue-next'

export function watchStateKey(
  item: WorkItem<WorkNode | WorkService>,
  cacheStats: CacheState,
  environment: Environment,
  options: CliExecOptions
): State<CacheState> {
  const state = new State<CacheState>(cacheStats)
  const debouncer = new Debouncer(async () => {
    if (environment.abortCtrl.signal.aborted) {
      return
    }

    const cacheState = await checkCacheState(item, item.data.caching ?? options.cacheDefault, environment)
    if (state.current.stateKey !== cacheState.stateKey) {
      state.set(cacheState)
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
