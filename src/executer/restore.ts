import { join, relative } from 'path'
import { moveFiles } from '../file/move-files'
import { WorkNodes } from '../planner/work-nodes'
import { iterateWorkNodes } from '../planner/utils/plan-work-nodes'
import { Environment } from './environment'
import { getCacheDirectory } from '../optimizer/get-cache-directory'

export async function restore(workNodes: WorkNodes, targetDirectory: string, context: Environment): Promise<void> {
  for (const node of iterateWorkNodes(workNodes)) {
    const cachePath = getCacheDirectory(node.id)
    const sourceCacheDir = join(targetDirectory, 'cache', node.id)

    await moveFiles(node, context, function* () {
      yield { from: sourceCacheDir, to: cachePath }

      for (const targetPath of node.generates) {
        const sourcePath = join(targetDirectory, relative(node.buildFile.path, targetPath))
        yield { from: sourcePath, to: targetPath }
      }
    })
  }
}
