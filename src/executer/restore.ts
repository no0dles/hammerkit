import { join, relative } from 'path'
import { moveFiles } from '../file/move-files'
import { BuildFile } from '../parser/build-file'
import { planWorkNodes } from '../planner/utils/plan-work-nodes'

export async function restore(buildFile: BuildFile, targetDirectory: string): Promise<void> {
  const tree = planWorkNodes(buildFile)

  await moveFiles(function* () {
    for (const key of Object.keys(tree)) {
      const node = tree[key]

      const cacheDir = join(node.path, '.hammerkit')
      const sourceCacheDir = join(targetDirectory, relative(buildFile.path, node.path), '.hammerkit')

      yield { from: sourceCacheDir, to: cacheDir }

      for (const targetPath of node.generates) {
        const sourcePath = join(targetDirectory, relative(buildFile.path, targetPath))
        yield { from: sourcePath, to: targetPath }
      }
    }
  })
}
