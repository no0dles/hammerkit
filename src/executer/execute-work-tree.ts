import { WorkTree } from '../planner/work-tree'
import { Environment } from './environment'
import { CliExecOptions } from '../cli'
import { iterateWorkNodes, iterateWorkServices } from '../planner/utils/plan-work-nodes'
import { executeWorkService, stopService } from './execute-work-service'
import { executeWorkTask } from './execute-work-task'

export async function executeWorkTree(work: WorkTree, environment: Environment, options: CliExecOptions) {
  const nodePromises: Promise<void>[] = []

  for (const node of iterateWorkNodes(work)) {
    if (node.state.current.type === 'pending') {
      nodePromises.push(executeWorkTask(node, environment, options))
    }
  }

  for (const service of iterateWorkServices(work)) {
    if (options.type === 'down') {
      if (service.state.current.type === 'running') {
        nodePromises.push(stopService(service, environment))
      }
    } else if (service.state.current.type === 'pending') {
      nodePromises.push(executeWorkService(service, environment, options))
    }
  }

  await Promise.all(nodePromises)
}
