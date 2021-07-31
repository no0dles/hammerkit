import { join, relative } from 'path'
import { moveFiles } from '../file/move-files'
import { WorkNodes } from '../planner/work-nodes'
import { iterateWorkNodes } from '../planner/utils/plan-work-nodes'
import { Environment } from './environment'
import { getCacheDirectory } from '../optimizer/get-cache-directory'

export async function store(workNodes: WorkNodes, targetDirectory: string, context: Environment): Promise<void> {
  for (const node of iterateWorkNodes(workNodes)) {
    const cachePath = getCacheDirectory(node.id)
    const sourceCacheDir = join(targetDirectory, 'cache', node.id)

    await moveFiles(node, context, function* () {
      yield { from: cachePath, to: sourceCacheDir }

      for (const sourcePath of node.generates) {
        const relativePath = relative(node.buildFile.path, sourcePath)
        const targetPath = join(targetDirectory, relativePath)
        yield { from: sourcePath, to: targetPath }
      }
    })
  }
}
