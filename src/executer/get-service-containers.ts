import { SchedulerState } from './scheduler/scheduler-state'
import { WorkNeed } from '../planner/work-service'
import { ServiceDns } from './service-dns'

export function getServiceContainers(currentState: SchedulerState, needs: WorkNeed[]): { [key: string]: ServiceDns } {
  const serviceContainers: { [key: string]: ServiceDns } = {}
  for (const need of needs) {
    const serviceState = currentState.service[need.service.id]
    if (serviceState.type === 'running') {
      serviceContainers[need.name] = serviceState.dns
    }
  }
  return serviceContainers
}
