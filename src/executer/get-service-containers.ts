import { SchedulerState } from './scheduler/scheduler-state'
import { ServiceDns } from './service-dns'
import { WorkItemNeed } from '../planner/work-item'

export function getServiceContainers(
  currentState: SchedulerState,
  needs: WorkItemNeed[]
): { [key: string]: ServiceDns } {
  const serviceContainers: { [key: string]: ServiceDns } = {}
  for (const need of needs) {
    const serviceState = currentState.service[need.service.id]
    if (serviceState.type === 'running') {
      serviceContainers[need.name] = serviceState.dns
    }
  }
  return serviceContainers
}
