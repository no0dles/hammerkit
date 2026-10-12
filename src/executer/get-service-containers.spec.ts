import { getServiceContainers } from './get-service-containers'
import { ServiceDns } from './service-dns'
import { State } from './state'
import { ServiceState } from './scheduler/service-state'
import { WorkItemNeed, WorkItemState } from '../planner/work-item'
import { WorkService } from '../planner/work-service'

function makeNeed(name: string, state: ServiceState): WorkItemNeed {
  const service = {
    id: () => name,
    name,
    state: new State<ServiceState>(state),
  } as unknown as WorkItemState<WorkService, ServiceState>
  return { name, service }
}

describe('get-service-containers', () => {
  it('skips needs that are not running', () => {
    const needs = [
      makeNeed('db', { type: 'pending', stateKey: null }),
      makeNeed('api', { type: 'starting', stateKey: null }),
    ]
    expect(getServiceContainers(needs)).toEqual({})
  })

  it('collects dns for running services', () => {
    const dns: ServiceDns = { containerId: 'abc' }
    const needs = [makeNeed('db', { type: 'running', stateKey: 'k', remote: null, dns })]
    expect(getServiceContainers(needs)).toEqual({ db: dns })
  })

  it('mixes host and container dns', () => {
    const containerDns: ServiceDns = { containerId: 'cid' }
    const hostDns: ServiceDns = { host: '10.0.0.1' }
    const needs = [
      makeNeed('db', { type: 'running', stateKey: 'k1', remote: null, dns: containerDns }),
      makeNeed('cache', { type: 'running', stateKey: 'k2', remote: null, dns: hostDns }),
    ]
    expect(getServiceContainers(needs)).toEqual({ db: containerDns, cache: hostDns })
  })
})
