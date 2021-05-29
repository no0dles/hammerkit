import { join, relative } from 'path'
import { remove } from '../file/remove'
import { existsSync } from 'fs'
import { copy } from '../file/copy'
import { nodes } from './1-plan'
import { ExecutionBuildFile } from './0-parse'
import consola from 'consola'

export async function store(buildFile: ExecutionBuildFile, targetDirectory: string): Promise<void> {
  const tree = nodes(buildFile)
  for (const key of Object.keys(tree)) {
    const node = tree[key]

    const cacheDir = join(node.path, '.hammerkit')
    const targetCacheDir = join(targetDirectory, relative(buildFile.path, node.path), '.hammerkit')
    if (existsSync(cacheDir) && !existsSync(targetCacheDir)) {
      copy(cacheDir, targetCacheDir)
    }

    for (const sourcePath of node.generates) {
      const relativePath = relative(buildFile.path, sourcePath)
      const targetPath = join(targetDirectory, relativePath)

      await remove(targetPath)

      if (!existsSync(sourcePath)) {
        continue
      }

      consola.debug(`copy ${sourcePath} to ${targetPath}`)
      copy(sourcePath, targetPath)
    }
  }
}
