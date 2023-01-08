import { SchedulerState } from './scheduler/scheduler-state'
import { WorkService } from '../planner/work-service'
import { ServiceDns } from './service-dns'

export function getServiceContainers(
  currentState: SchedulerState,
  needs: WorkService[]
): { [key: string]: ServiceDns } {
  const serviceContainers: { [key: string]: ServiceDns } = {}
  for (const need of needs) {
    const serviceState = currentState.service[need.id]
    if (serviceState.type === 'running') {
      serviceContainers[need.id] = serviceState.dns
    }
  }
  return serviceContainers
}
