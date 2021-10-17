import { WorkNodes } from '../planner/work-nodes'
import { iterateWorkNodes } from '../planner/utils/plan-work-nodes'
import { Environment } from './environment'
import { getCacheDirectory } from '../optimizer/get-cache-directory'
import { Executor } from './executor'
import { WorkServices } from '../planner/work-services'

export async function clean(
  workNodes: WorkNodes,
  workServices: WorkServices,
  environment: Environment,
  executor: Executor
): Promise<void> {
  await executor.prepareRun(workNodes, workServices)

  for (const node of iterateWorkNodes(workNodes)) {
    await executor.clean(node, environment)

    const cachePath = getCacheDirectory(node.id)
    if (await environment.file.exists(cachePath)) {
      node.status.console.write('internal', 'info', `remove cache ${cachePath}`)
      await environment.file.remove(cachePath)
    }
  }
}
