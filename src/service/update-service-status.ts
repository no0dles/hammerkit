import { Environment } from '../executer/environment'
import { iterateWorkServices } from '../planner/utils/plan-work-nodes'
import { WorkTree } from '../planner/work-tree'

export async function updateServiceStatus(workTree: WorkTree, environment: Environment): Promise<void> {
  for (const service of iterateWorkServices(workTree)) {
    const currentServices = await environment.docker.listContainers({
      filters: {
        label: [`hammerkit-id=${service.id}`],
      },
    })
    const currentService = currentServices[0]
    if (!currentService) {
      continue
    }

    const servicePid =
      'hammerkit-pid' in currentService.Labels ? parseInt(currentService.Labels['hammerkit-pid']) : undefined
    const serviceState = 'hammerkit-state' in currentService.Labels ? currentService.Labels['hammerkit-state'] : ''

    service.state.set({
      type: 'running',
      remote: { containerId: currentService.Id, pid: servicePid },
      stateKey: serviceState,
      dns: {
        containerId: currentService.Id,
      },
    })
  }
}
