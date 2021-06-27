import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import consola from 'consola'
import { WorkNode } from '../planner/work-node'
import { WorkNodeCacheStats } from './work-node-cache-stats'

export function readCache(node: WorkNode): WorkNodeCacheStats | null {
  const cacheFile = join(node.path, '.hammerkit', node.name + '.json')
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
