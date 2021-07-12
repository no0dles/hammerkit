import { join, relative } from 'path'
import { moveFiles } from '../file/move-files'
import { WorkNodes } from '../planner/work-nodes'
import { iterateWorkNodes } from '../planner/utils/plan-work-nodes'
import { Environment } from '../run-arg'

export async function restore(workNodes: WorkNodes, targetDirectory: string, context: Environment): Promise<void> {
  for (const node of iterateWorkNodes(workNodes)) {
    const cacheDir = join(node.cwd, '.hammerkit')
    const sourceCacheDir = join(targetDirectory, relative(node.buildFile.path, node.cwd), '.hammerkit')

    await moveFiles(node, context, function* () {
      yield { from: sourceCacheDir, to: cacheDir }

      for (const targetPath of node.generates) {
        const sourcePath = join(targetDirectory, relative(node.buildFile.path, targetPath))
        yield { from: sourcePath, to: targetPath }
      }
    })
  }
}
