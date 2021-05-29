import { join, relative } from 'path'
import { nodes } from './1-plan'
import { ExecutionBuildFile } from './0-parse'
import { moveFiles } from './7-restore'

export async function store(buildFile: ExecutionBuildFile, targetDirectory: string): Promise<void> {
  const tree = nodes(buildFile)

  await moveFiles(function* () {
    for (const key of Object.keys(tree)) {
      const node = tree[key]

      const cacheDir = join(node.path, '.hammerkit')
      const sourceCacheDir = join(targetDirectory, relative(buildFile.path, node.path), '.hammerkit')

      yield { from: cacheDir, to: sourceCacheDir }

      for (const sourcePath of node.generates) {
        const relativePath = relative(buildFile.path, sourcePath)
        const targetPath = join(targetDirectory, relativePath)
        yield { from: sourcePath, to: targetPath }
      }
    }
  })
}
