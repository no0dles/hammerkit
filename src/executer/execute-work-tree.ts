import { WorkTree } from '../planner/work-tree'
import { Environment } from './environment'
import { CliExecOptions } from '../cli'
import { iterateWorkTasks, iterateWorkServices } from '../planner/utils/plan-work-tasks'
import { executeWorkService, stopService } from './execute-work-service'
import { executeWorkTask } from './execute-work-task'

export async function executeWorkTree(work: WorkTree, environment: Environment, options: CliExecOptions) {
  const itemPromises: Promise<void>[] = []

  for (const task of iterateWorkTasks(work)) {
    if (task.state.current.type === 'pending') {
      itemPromises.push(executeWorkTask(task, environment, options))
    }
  }

  for (const service of iterateWorkServices(work)) {
    if (options.type === 'down') {
      if (service.state.current.type === 'running') {
        itemPromises.push(stopService(service))
      }
    } else if (service.state.current.type === 'pending') {
      itemPromises.push(executeWorkService(service, environment, options))
    }
  }

  await Promise.all(itemPromises)
}
