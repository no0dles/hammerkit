import { Environment } from '../environment'
import { CacheMethod } from '../../parser/cache-method'
import { isWorkTaskItem, WorkItemState } from '../../planner/work-item'
import { WorkTask } from '../../planner/work-task'
import { WorkService } from '../../planner/work-service'
import { ResolvedCache } from '../../cache/resolve-cache'
import { getCacheDirectory } from '../../optimizer/get-cache-directory'
import { writeCacheMetadata } from '../cache-metadata'
import { getWorkTaskCacheDescription } from '../../optimizer/work-task-cache-description'
import { getErrorMessage } from '../../log'
import { computeStateKey } from './state-key'

export interface CacheState {
  cached: boolean
  stateKey: string
  resolved: ResolvedCache
}

export async function checkCacheState(
  item: WorkItemState<WorkTask | WorkService, any>,
  defaultCacheMethod: CacheMethod,
  environment: Environment
): Promise<CacheState> {
  const { stateKey, stats: currentStats, resolved } = await computeStateKey(item, defaultCacheMethod, environment)

  if (resolved.method === 'none') {
    item.status.write('debug', `${item.name} is skipping cache check, because caching is disabled`)
    return { cached: false, stateKey, resolved }
  }

  if (isWorkTaskItem(item)) {
    const runtimeStateKey = await item.runtime.currentStateKey(environment)

    if (runtimeStateKey === stateKey) {
      return { cached: true, stateKey, resolved }
    }

    try {
      const cacheDir = getCacheDirectory(item.id())
      const pulled = await resolved.backend.pull(item.id(), stateKey, cacheDir, environment)
      if (pulled) {
        item.status.write('info', `${item.name} pulled from cache "${resolved.name}" (${resolved.backend.type})`)
        await item.runtime.restore(environment, cacheDir)
        await writeCacheMetadata(environment, item, currentStats, getWorkTaskCacheDescription(item.data))
        return { cached: true, stateKey, resolved }
      }
    } catch (e) {
      item.status.write(
        'warn',
        `${item.name} failed to pull from cache "${resolved.name}": ${getErrorMessage(
          e
        )} — continuing with local execution`
      )
    }
  }

  return { cached: false, stateKey, resolved }
}
