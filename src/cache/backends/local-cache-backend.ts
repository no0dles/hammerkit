import { join } from 'path'
import { homedir } from 'os'
import { CacheBackend } from '../cache-backend'
import { Environment } from '../../executer/environment'

export interface LocalCacheBackendSpec {
  type: 'local'
  path?: string
}

export function createLocalCacheBackend(spec: LocalCacheBackendSpec): CacheBackend {
  const root = spec.path ?? join(homedir(), '.hammerkit', 'remote-cache')
  return {
    type: 'local',
    async has(taskId, stateKey, environment): Promise<boolean> {
      const statsPath = join(root, taskId, stateKey, 'stats.json')
      try {
        return await environment.file.exists(statsPath)
      } catch {
        return false
      }
    },
    async pull(taskId, stateKey, into, environment): Promise<boolean> {
      const remoteDir = join(root, taskId, stateKey)
      const statsPath = join(remoteDir, 'stats.json')
      if (!(await environment.file.exists(statsPath))) {
        return false
      }
      await environment.file.createDirectory(into)
      try {
        for (const file of await environment.file.listFiles(remoteDir)) {
          await environment.file.copy(join(remoteDir, file), join(into, file))
        }
        return true
      } catch (e) {
        return false
      }
    },
    async push(taskId, stateKey, from, environment): Promise<void> {
      const remoteDir = join(root, taskId, stateKey)
      await environment.file.createDirectory(remoteDir)
      // Write data files first; stats.json last so a partial push is invisible to has()/pull().
      const files = await environment.file.listFiles(from)
      const ordered = [
        ...files.filter((f) => f !== 'stats.json' && f !== 'description.json'),
        ...files.filter((f) => f === 'description.json'),
        ...files.filter((f) => f === 'stats.json'),
      ]
      for (const file of ordered) {
        await environment.file.copy(join(from, file), join(remoteDir, file))
      }
    },
  }
}
