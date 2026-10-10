import { join } from 'path'
import { homedir } from 'os'
import { readdir, readFile, stat, writeFile } from 'fs/promises'
import { CacheBackend, CacheEntry } from '../cache-backend'

export interface LocalCacheBackendSpec {
  type: 'local'
  path?: string
}

// Hammerkit-owned last-use marker inside each entry directory, updated on every
// pull. Filesystem atime is unreliable (relatime/noatime), so retention reads
// this instead. Never copied out of the cache.
const LAST_ACCESS_FILE = '.last-access'

async function directories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
}

export function createLocalCacheBackend(spec: LocalCacheBackendSpec): CacheBackend {
  const root = spec.path ?? join(homedir(), '.hammerkit', 'remote-cache')

  async function readEntry(taskId: string, stateKey: string): Promise<CacheEntry | null> {
    const dir = join(root, taskId, stateKey)
    let created: number
    try {
      // stats.json is written last, so its presence marks a complete entry
      created = (await stat(join(dir, 'stats.json'))).mtimeMs
    } catch {
      return null
    }
    let size = 0
    let lastAccessedAt: number | null = null
    for (const file of await readdir(dir)) {
      if (file === LAST_ACCESS_FILE) {
        const value = parseInt(await readFile(join(dir, file), 'utf8'), 10)
        lastAccessedAt = Number.isNaN(value) ? null : value
        continue
      }
      size += (await stat(join(dir, file))).size
    }
    return { taskId, stateKey, size, createdAt: Math.round(created), lastAccessedAt }
  }

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
          if (file === LAST_ACCESS_FILE) {
            continue
          }
          await environment.file.copy(join(remoteDir, file), join(into, file))
        }
        await writeFile(join(remoteDir, LAST_ACCESS_FILE), `${Date.now()}`)
        return true
      } catch (e) {
        return false
      }
    },
    async push(taskId, stateKey, from, environment): Promise<void> {
      const remoteDir = join(root, taskId, stateKey)
      await environment.file.createDirectory(remoteDir)
      // Write data files first; stats.json last so a partial push is invisible to has()/pull().
      const files = (await environment.file.listFiles(from)).filter((f) => f !== LAST_ACCESS_FILE)
      const ordered = [
        ...files.filter((f) => f !== 'stats.json' && f !== 'description.json'),
        ...files.filter((f) => f === 'description.json'),
        ...files.filter((f) => f === 'stats.json'),
      ]
      for (const file of ordered) {
        await environment.file.copy(join(from, file), join(remoteDir, file))
      }
    },
    async clear(taskId, environment): Promise<void> {
      await environment.file.remove(join(root, taskId))
    },
    async list(): Promise<CacheEntry[]> {
      const entries: CacheEntry[] = []
      for (const taskId of await directories(root)) {
        for (const stateKey of await directories(join(root, taskId))) {
          const entry = await readEntry(taskId, stateKey)
          if (entry) {
            entries.push(entry)
          }
        }
      }
      return entries
    },
    async remove(taskId, stateKey, environment): Promise<void> {
      await environment.file.remove(join(root, taskId, stateKey))
      if ((await directories(join(root, taskId))).length === 0) {
        await environment.file.remove(join(root, taskId))
      }
    },
  }
}
