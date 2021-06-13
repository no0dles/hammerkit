import { TreeDependencies, TreeDependencyNode } from './2-restructure'
import { join, dirname } from 'path'
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { ContainerMount, TaskNode, TaskNodeCmd } from './1-plan'
import consola from 'consola'
import { createHash } from 'crypto'
import { CacheMethod } from './4-execute'

export interface TreeNodeCache {
  src: string[]
  generates: string[]
  image: string | null
  mounts: ContainerMount[]
  cmds: TaskNodeCmd[]
  envs: { [key: string]: string }
}

export interface TreeNodeCacheFile {
  task: TreeNodeCache
  stats: TreeNodeCacheStats
}

export interface TreeNodeCacheStats {
  [key: string]: { lastModified: number; checksum: string }
}

export async function optimize(tree: TreeDependencies, cacheMethod: CacheMethod): Promise<void> {
  for (const key of Object.keys(tree)) {
    const node = tree[key]
    if (node.task.src.length === 0) {
      continue
    }

    const cache = readCache(node)
    if (!cache) {
      consola.debug(`${node.task.name} can't be skipped because there is no cache`)
      continue
    }

    const current = getCache(node)
    if (current.image !== cache.task.image) {
      consola.debug(`${node.task.name} can't be skipped because task image has been modified`)
      continue
    }

    // TODO compare other attrs

    const currentStats = await getCacheStats(node.task)
    let changed = false
    for (const key of Object.keys(cache.stats)) {
      if (
        (cacheMethod === 'checksum' && currentStats[key]?.checksum !== cache.stats[key].checksum) ||
        (cacheMethod === 'modify-date' && currentStats[key]?.lastModified !== cache.stats[key].lastModified)
      ) {
        consola.debug(`${node.task.name} can't be skipped because ${key} has been modified`)
        changed = true
        break
      }
    }

    if (changed) {
      continue
    }

    consola.debug(`${node.task.name} is skipped because it's cache is up to date`)
    removeTask(key, tree)
  }
}

function removeTask(keyToRemove: string, tree: TreeDependencies) {
  delete tree[keyToRemove]
  for (const key of Object.keys(tree)) {
    const index = tree[key].dependencies.indexOf(keyToRemove)
    if (index >= 0) {
      tree[key].dependencies.splice(index, 1)
    }
  }
}

function getCache(node: TreeDependencyNode): TreeNodeCache {
  return {
    src: node.task.src.map((s) => s.absolutePath),
    generates: node.task.generates,
    cmds: node.task.cmds,
    image: node.task.image,
    mounts: node.task.mounts,
    envs: node.task.envs,
  }
}

async function getCacheStats(cache: TaskNode): Promise<TreeNodeCacheStats> {
  const result: TreeNodeCacheStats = {}

  for (const src of cache.src) {
    await getStats(result, src.absolutePath, (file) => src.matcher(file, cache.path))
  }

  return result
}

function getChecksum(path: string): Promise<string> {
  return new Promise(function (resolve, reject) {
    const hash = createHash('sha1')
    const input = createReadStream(path)

    input.on('error', reject)

    input.on('data', (chunk) => {
      hash.update(chunk)
    })

    input.on('close', () => {
      resolve(hash.digest('hex'))
    })
  })
}

async function getStats(result: TreeNodeCacheStats, path: string, matcher: (file: string) => boolean) {
  const stats = statSync(path)
  if (stats.isFile()) {
    if (matcher(path)) {
      const checksum = await getChecksum(path)
      result[path] = { lastModified: stats.mtimeMs, checksum }
    }
  } else if (stats.isDirectory()) {
    const files = readdirSync(path)
    for (const file of files) {
      const subPath = join(path, file)
      if (matcher(subPath)) {
        await getStats(result, join(path, file), matcher)
      }
    }
  }
}

export async function writeCache(node: TreeDependencyNode): Promise<void> {
  consola.debug(`write cache for ${node.task.name}`)
  const cacheFile = join(node.task.path, '.hammerkit', node.task.name + '.json')
  const cache = getCache(node)
  const content: TreeNodeCacheFile = {
    task: cache,
    stats: await getCacheStats(node.task),
  }
  mkdirSync(dirname(cacheFile), { recursive: true })
  writeFileSync(cacheFile, JSON.stringify(content, null, 2))
}

export function readCache(node: TreeDependencyNode): TreeNodeCacheFile | null {
  const cacheFile = join(node.task.path, '.hammerkit', node.task.name + '.json')
  if (!existsSync(cacheFile)) {
    return null
  }

  try {
    return JSON.parse(readFileSync(cacheFile).toString())
  } catch (e) {
    consola.warn(`unable to read cache ${cacheFile}`)
  }

  return null
}
