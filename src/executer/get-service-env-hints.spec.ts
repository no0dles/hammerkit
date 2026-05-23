import { getServiceEnvHints } from './get-service-env-hints'
import { State } from './state'
import { ServiceState } from './scheduler/service-state'
import { WorkItemNeed, WorkItemState } from '../planner/work-item'
import { WorkService } from '../planner/work-service'

function makeNeed(name: string, state: ServiceState, ports: { hostPort: number | null; containerPort: number }[] = []): WorkItemNeed {
  const service = {
    id: () => name,
    name,
    data: { ports } as any,
    state: new State<ServiceState>(state),
  } as unknown as WorkItemState<WorkService, ServiceState>
  return { name, service }
}

describe('getServiceEnvHints', () => {
  it('returns nothing for non-running needs', () => {
    const needs = [makeNeed('db', { type: 'pending', stateKey: null })]
    expect(getServiceEnvHints(needs)).toEqual({})
  })

  it('emits a localhost host hint for docker container services', () => {
    const needs = [
      makeNeed(
        'db',
        { type: 'running', stateKey: 'k', remote: null, dns: { containerId: 'abc' } },
        [{ hostPort: 5432, containerPort: 5432 }]
      ),
    ]
    expect(getServiceEnvHints(needs)).toEqual({
      HAMMERKIT_DB_HOST: '127.0.0.1',
      HAMMERKIT_DB_PORT: '5432',
      HAMMERKIT_DB_PORT_5432: '5432',
    })
  })

  it('uses the dns host for host-style services', () => {
    const needs = [
      makeNeed(
        'api',
        { type: 'running', stateKey: 'k', remote: null, dns: { host: '10.0.0.7' } },
        [{ hostPort: null, containerPort: 8080 }]
      ),
    ]
    expect(getServiceEnvHints(needs)).toEqual({
      HAMMERKIT_API_HOST: '10.0.0.7',
      HAMMERKIT_API_PORT: '8080',
      HAMMERKIT_API_PORT_8080: '8080',
    })
  })

  it('exposes every published port under its container-port suffix', () => {
    const needs = [
      makeNeed(
        'web',
        { type: 'running', stateKey: 'k', remote: null, dns: { containerId: 'x' } },
        [
          { hostPort: 8080, containerPort: 80 },
          { hostPort: 8443, containerPort: 443 },
        ]
      ),
    ]
    const env = getServiceEnvHints(needs)
    expect(env).toEqual({
      HAMMERKIT_WEB_HOST: '127.0.0.1',
      HAMMERKIT_WEB_PORT: '8080',
      HAMMERKIT_WEB_PORT_80: '8080',
      HAMMERKIT_WEB_PORT_443: '8443',
    })
  })

  it('sanitizes weird names into env-safe keys', () => {
    const needs = [
      makeNeed(
        'my.service:1',
        { type: 'running', stateKey: 'k', remote: null, dns: { containerId: 'x' } },
        []
      ),
    ]
    expect(getServiceEnvHints(needs)).toEqual({ HAMMERKIT_MY_SERVICE_1_HOST: '127.0.0.1' })
  })
})
