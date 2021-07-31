import { WorkNodes } from '../planner/work-nodes'
import { iterateWorkNodes } from '../planner/utils/plan-work-nodes'
import { Environment } from './environment'
import { getCacheDirectory } from '../optimizer/get-cache-directory'

export async function clean(workNodes: WorkNodes, context: Environment): Promise<void> {
  for (const node of iterateWorkNodes(workNodes)) {
    for (const generate of node.generates) {
      if (await context.file.exists(generate)) {
        node.status.console.write('internal', 'info', `remove generate ${generate}`)
        await context.file.remove(generate)
      }
    }

    const cachePath = getCacheDirectory(node.id)
    if (await context.file.exists(cachePath)) {
      node.status.console.write('internal', 'info', `remove cache ${cachePath}`)
      await context.file.remove(cachePath)
    }
  }
}
