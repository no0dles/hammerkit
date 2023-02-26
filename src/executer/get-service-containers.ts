import { ServiceDns } from './service-dns'
import { WorkItemNeed } from '../planner/work-item'

export function getServiceContainers(needs: WorkItemNeed[]): { [key: string]: ServiceDns } {
  const serviceContainers: { [key: string]: ServiceDns } = {}
  for (const need of needs) {
    if (need.service.state.current.type === 'running') {
      serviceContainers[need.name] = need.service.state.current.dns
    }
  }
  return serviceContainers
}
