import { join, relative } from 'path'
import { moveFiles } from '../file/move-files'
import { WorkNodes } from '../planner/work-nodes'
import { iterateWorkNodes } from '../planner/utils/plan-work-nodes'
import { Environment } from './environment'
import { getCacheDirectory } from '../optimizer/get-cache-directory'
import { Executor } from './executor'

export async function restore(
  workNodes: WorkNodes,
  targetDirectory: string,
  environment: Environment,
  executor: Executor
): Promise<void> {
  for (const node of iterateWorkNodes(workNodes)) {
    const cachePath = getCacheDirectory(node.id)
    const sourceCacheDir = join(targetDirectory, 'cache', node.id)

    await moveFiles(node, environment, function* () {
      yield { from: sourceCacheDir, to: cachePath }
    })

    try {
      await executor.restore(node, environment, targetDirectory)
    } catch (e) {
      console.error(e)
      throw e
    }
  }
}
