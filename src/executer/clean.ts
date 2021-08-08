import { WorkNodes } from '../planner/work-nodes'
import { iterateWorkNodes } from '../planner/utils/plan-work-nodes'
import { Environment } from './environment'
import { getCacheDirectory } from '../optimizer/get-cache-directory'
import { isContainerWorkNode } from '../planner/work-node'
import { getVolumeName } from './execute-docker'
import { Executor } from './executor'

export async function clean(workNodes: WorkNodes, environment: Environment, executor: Executor): Promise<void> {
  for (const node of iterateWorkNodes(workNodes)) {
    await executor.clean(node, environment)

    const cachePath = getCacheDirectory(node.id)
    if (await environment.file.exists(cachePath)) {
      node.status.console.write('internal', 'info', `remove cache ${cachePath}`)
      await environment.file.remove(cachePath)
    }
  }
}
