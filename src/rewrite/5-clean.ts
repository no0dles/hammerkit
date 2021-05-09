import { remove } from '../file/remove'
import { nodes } from './1-plan'
import { ExecutionBuildFile } from './0-parse'
import { join } from 'path'
import { existsSync } from 'fs'
import consola from 'consola'

export async function clean(buildFile: ExecutionBuildFile): Promise<void> {
  const tree = nodes(buildFile)
  for (const key of Object.keys(tree)) {
    const node = tree[key]
    for (const generate of node.generates) {
      if (existsSync(generate)) {
        consola.info(`remove generate ${generate}`)
        await remove(generate)
      }
    }
    const cachePath = join(node.path, '.hammerkit')
    if (existsSync(cachePath)) {
      consola.info(`remove cache ${cachePath}`)
      await remove(cachePath)
    }
  }
}
