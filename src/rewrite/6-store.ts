import { join, relative } from 'path'
import { remove } from '../file/remove'
import { existsSync } from 'fs'
import { copy } from '../file/copy'
import { nodes } from './1-plan'
import { ExecutionBuildFile } from './0-parse'

export async function store(buildFile: ExecutionBuildFile, targetDirectory: string): Promise<void> {
  const tree = nodes(buildFile)
  for (const key of Object.keys(tree)) {
    const node = tree[key]
    for (const sourcePath of node.generates) {
      const relativePath = relative(buildFile.path, sourcePath)
      const targetPath = join(targetDirectory, relativePath)

      await remove(targetPath)

      if (!existsSync(sourcePath)) {
        continue
      }

      copy(sourcePath, targetPath)
    }
  }
}
