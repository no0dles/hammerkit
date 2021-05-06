import { remove } from '../file/remove'
import { nodes } from './1-plan'
import { ExecutionBuildFile } from './0-parse'
import { join } from 'path'
import { existsSync } from 'fs'

export async function clean(buildFile: ExecutionBuildFile): Promise<void> {
  const tree = nodes(buildFile)
  for (const key of Object.keys(tree)) {
    const node = tree[key]
    for (const generate of node.generates) {
      await remove(generate)
    }
    const cachePath = join(node.path, '.hammerkit')
    if (existsSync(cachePath)) {
      await remove(cachePath)
    }
  }
}
