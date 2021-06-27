import { join, relative } from 'path'
import { moveFiles } from '../file/move-files'
import { planWorkNodes } from '../planner/utils/plan-work-nodes'
import { BuildFile } from '../parser/build-file'

export async function store(buildFile: BuildFile, targetDirectory: string): Promise<void> {
  const tree = planWorkNodes(buildFile)

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
