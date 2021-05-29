import { join, relative } from 'path'
import { existsSync } from 'fs'
import { copy } from '../file/copy'
import { remove } from '../file/remove'
import { nodes } from './1-plan'
import { ExecutionBuildFile } from './0-parse'
import consola from 'consola'

export async function restore(buildFile: ExecutionBuildFile, targetDirectory: string): Promise<void> {
  const tree = nodes(buildFile)
  for (const key of Object.keys(tree)) {
    const node = tree[key]

    const cacheDir = join(node.path, '.hammerkit')
    const sourceCacheDir = join(targetDirectory, relative(buildFile.path, node.path), '.hammerkit');
    if (existsSync(sourceCacheDir) && !existsSync(cacheDir)) {
      copy(sourceCacheDir, cacheDir)
    }

    for (const targetPath of node.generates) {
      const sourcePath = join(targetDirectory, relative(buildFile.path, targetPath))

      if (!existsSync(sourcePath)) {
        continue
      }

      if (existsSync(targetPath)) {
        await remove(targetPath)
      }

      consola.debug(`copy ${sourcePath} to ${targetPath}`)
      copy(sourcePath, targetPath)
    }
  }
}
