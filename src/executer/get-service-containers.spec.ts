import { getServiceContainers } from './get-service-containers'
import { getNeedsNetwork } from './docker-task'
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

describe('getNeedsNetwork', () => {
  it('returns empty links and hosts when there are no needs', () => {
    const result = getNeedsNetwork({}, [])
    expect(result).toEqual({ links: [], hosts: [] })
  })

  it('maps container dns to docker Links', () => {
    const needs = [makeNeed('db', { type: 'running', stateKey: 'k', remote: null, dns: { containerId: 'cid' } })]
    const result = getNeedsNetwork({ db: { containerId: 'cid' } }, needs)
    expect(result.links).toEqual(['cid:db'])
    expect(result.hosts).toEqual([])
  })

  it('maps host dns to docker ExtraHosts', () => {
    const needs = [makeNeed('api', { type: 'running', stateKey: 'k', remote: null, dns: { host: '127.0.0.1' } })]
    const result = getNeedsNetwork({ api: { host: '127.0.0.1' } }, needs)
    expect(result.hosts).toEqual(['api:127.0.0.1'])
    expect(result.links).toEqual([])
  })

  it('throws when a container service has no containerId', () => {
    const needs = [makeNeed('db', { type: 'pending', stateKey: null })]
    expect(() => getNeedsNetwork({ db: { containerId: '' } }, needs)).toThrow(/service db is not running/)
  })
})
