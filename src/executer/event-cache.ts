import { EventBus } from './event-bus'
import { Environment } from './environment'
import { iterateWorkNodes, iterateWorkServices } from '../planner/utils/plan-work-nodes'
import { getCacheDirectory } from '../optimizer/get-cache-directory'
import { join } from 'path'
import { moveFiles } from '../file/move-files'
import { CacheCleanEvent, CacheRestoreEvent, CacheStoreEvent, NodeCompletedEvent } from './events'
import { writeWorkNodeCache } from '../optimizer/write-work-node-cache'

export function attachCaching(eventBus: EventBus, environment: Environment) {
  eventBus.on<NodeCompletedEvent>('node-completed', async (evt) => {
    await writeWorkNodeCache(evt.node, environment)
  })
  eventBus.on<CacheCleanEvent>('cache-clean', async (evt) => {
    for (const node of iterateWorkNodes(evt.nodes)) {
      await eventBus.emit({
        type: 'node-cleanup',
        node,
      })
    }

    for (const service of iterateWorkServices(evt.services)) {
      await eventBus.emit({
        type: 'service-cleanup',
        service,
      })
    }

    for (const node of iterateWorkNodes(evt.nodes)) {
      await eventBus.emit({
        type: 'node-prune-state',
        node,
      })

      const cachePath = getCacheDirectory(node.id)
      if (await environment.file.exists(cachePath)) {
        node.status.write('info', `remove cache ${cachePath}`)
        await environment.file.remove(cachePath)
      }
    }
  })
  eventBus.on<CacheStoreEvent>('cache-store', async (evt) => {
    for (const node of iterateWorkNodes(evt.nodes)) {
      const cachePath = getCacheDirectory(node.id)
      const sourceCacheDir = join(evt.path, 'cache', node.id)

      await moveFiles(node, environment, function* () {
        yield { from: cachePath, to: sourceCacheDir }
      })

      await eventBus.emit({
        type: 'node-store-state',
        node,
        path: evt.path,
      })
    }
  })
  eventBus.on<CacheRestoreEvent>('cache-restore', async (evt) => {
    for (const node of iterateWorkNodes(evt.nodes)) {
      const cachePath = getCacheDirectory(node.id)
      const sourceCacheDir = join(evt.path, 'cache', node.id)

      await moveFiles(node, environment, function* () {
        yield { from: sourceCacheDir, to: cachePath }
      })

      await eventBus.emit({
        type: 'node-restore-state',
        node,
        path: evt.path,
      })
    }
  })
}
