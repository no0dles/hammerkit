import { join } from 'path'
import {writeLog} from '../log';
import {WorkNodes} from '../planner/work-nodes';
import {iterateWorkNodes} from '../planner/utils/plan-work-nodes';
import {Context} from '../run-arg';

export async function clean(workNodes: WorkNodes, context: Context): Promise<void> {
  for (const node of iterateWorkNodes(workNodes)) {
    for (const generate of node.generates) {
      if (await context.file.exists(generate)) {
        writeLog(node.status.stdout, 'info', `remove generate ${generate}`)
        await context.file.remove(generate)
      }
    }
    const cachePath = join(node.cwd, '.hammerkit')
    if (await context.file.exists(cachePath)) {
      writeLog(node.status.stdout, 'info', `remove cache ${cachePath}`)
      await context.file.remove(cachePath)
    }
  }
}
