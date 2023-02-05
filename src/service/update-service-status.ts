import { Environment } from '../executer/environment'
import { iterateWorkServices } from '../planner/utils/plan-work-nodes'
import { State } from '../executer/state'

export async function updateServiceStatus(state: State, environment: Environment): Promise<void> {
  for (const service of iterateWorkServices(state.current.service)) {
    const currentServices = await environment.docker.listContainers({
      all: true,
      filters: {
        label: [`hammerkit-id=${service.itemId}`],
      },
    })
    const currentService = currentServices[0]
    if (!currentService) {
      continue
    }

    const servicePid =
      'hammerkit-pid' in currentService.Labels ? parseInt(currentService.Labels['hammerkit-pid']) : undefined
    const serviceState = 'hammerkit-state' in currentService.Labels ? currentService.Labels['hammerkit-state'] : ''

    state.patchService({
      service: service.service,
      itemId: service.itemId,
      type: 'running',
      remote: { containerId: currentService.Id, pid: servicePid },
      stateKey: serviceState,
      dns: {
        containerId: currentService.Id,
      },
    })
  }
}
