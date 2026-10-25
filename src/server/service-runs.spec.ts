import { runRequestSchema } from './run-request'
import { serverConfigSchema } from './server-config'
import { getEndpointHosts, getServiceRunName, mayOpenEndpoints, refuseEndpoints } from './service-runs'
import { getEndpointTargets, publishEndpoints } from './run-worker'
import { getServiceRunNamespace, getServerIngressPolicy, isCallerNamespace } from './kubernetes-backend'
import type { TaskPlan } from './plan'

const ISS = 'https://idp.corp'
const definition = 'sha256:' + 'a'.repeat(64)
const source = { type: 'ref', repo: 'github.com/corp/shop', ref: 'main' }

describe('service run requests', () => {
  const parse = (request: object) => runRequestSchema.safeParse({ definition, source, tasks: [], ...request })

  it('takes services with a ttl, a name and endpoints', () => {
    const parsed = parse({ services: ['web'], ttl: '2h', name: 'pr-12', endpoints: [{ service: 'web', port: 80 }] })
    expect(parsed.success).toBe(true)
  })

  it('refuses what a service run can not be', () => {
    const issue = (request: object) => {
      const parsed = parse(request)
      return parsed.success ? null : parsed.error.issues[0].message
    }
    expect(issue({ services: ['web'], tasks: ['build'] })).toBe('a run names tasks or services, not both')
    expect(issue({ tasks: ['build'], endpoints: [{ service: 'web', port: 80 }] })).toBe(
      'ttl, sleepTtl, name and endpoints are for a run of services'
    )
    expect(issue({ services: ['web'], name: 'Feature/Login' })).toMatch(/DNS label/)
    expect(issue({ services: ['web'], options: { args: ['x'] } })).toBe('a service run takes no arguments')
    expect(
      issue({
        services: ['web'],
        endpoints: [
          { service: 'web', port: 80 },
          { service: 'web', port: 80 },
        ],
      })
    ).toBe('an endpoint is named twice')
  })
})

describe('service run names and hosts', () => {
  it('names a run after its branch, as a DNS label', () => {
    expect(getServiceRunName('feature/Login_Page')).toBe('feature-login-page')
    expect(getServiceRunName('---')).toBe('run')
    expect(getServiceRunName(undefined)).toBe('run')
    expect(getServiceRunName('x'.repeat(80))).toHaveLength(40)
  })

  it('gives each caller hosts of their own, and two endpoints on one port hosts apart', () => {
    const [mine] = getEndpointHosts('pr-12', { iss: ISS, sub: 'alice' }, [{ service: 'web', port: 80 }])
    const [theirs] = getEndpointHosts('pr-12', { iss: ISS, sub: 'bob' }, [{ service: 'web', port: 80 }])
    expect(mine).toMatch(/^pr-12-80-[0-9a-f]{12}$/)
    expect(theirs).not.toBe(mine)
    const hosts = getEndpointHosts('pr-12', { iss: ISS, sub: 'alice' }, [
      { service: 'web', port: 80 },
      { service: 'admin', port: 80 },
    ])
    expect(new Set(hosts).size).toBe(2)
  })

  it('opens the endpoints of a repository to who has a level for it', () => {
    const grant = { endpoints: [{ repo: 'github.com/corp/*', level: 'open' as const }] } as any
    expect(mayOpenEndpoints(grant, { source: { ...source, commit: 'c' } as any })).toBe(true)
    expect(mayOpenEndpoints(grant, { source: { ...source, repo: 'github.com/other/x', commit: 'c' } as any })).toBe(
      false
    )
    expect(mayOpenEndpoints(grant, { source: { type: 'upload', snapshot: 's' } as any })).toBe(false)
  })
})

describe('refuseEndpoints', () => {
  const plan = (item: Partial<TaskPlan>) => ({ kind: 'service', ports: ['8080:80'], secrets: [], ...item }) as TaskPlan

  it('wants a port the service declares', () => {
    expect(refuseEndpoints({ endpoints: [{ service: 'web', port: 80 }] }, { web: plan({}) }, true)).toBeNull()
    expect(refuseEndpoints({ endpoints: [{ service: 'web', port: 8080 }] }, { web: plan({}) }, true)).toBe(
      'web has no port 8080, its ports are 80'
    )
    expect(refuseEndpoints({ endpoints: [{ service: 'db', port: 80 }] }, { web: plan({}) }, true)).toMatch(
      /names no service/
    )
  })

  it('keeps a service that reads a secret off an endpoint unless secrets may go anywhere', () => {
    const web = plan({ secrets: [{ from: 'gcp:key', account: 'dev', target: 'env:KEY' }] as any })
    expect(refuseEndpoints({ endpoints: [{ service: 'web', port: 80 }] }, { web }, false)).toMatch(
      /web reads the secret env:KEY/
    )
    expect(refuseEndpoints({ endpoints: [{ service: 'web', port: 80 }] }, { web }, true)).toBeNull()
  })
})

describe('the ports of a service run', () => {
  const tree = () =>
    ({
      services: {
        web: {
          name: 'web',
          id: () => 'abc123',
          data: {
            ports: [
              { hostPort: 8080, containerPort: 80 },
              { hostPort: 9229, containerPort: 9229 },
            ],
          },
          state: { current: { type: 'running', published: [{ containerPort: 80, host: '127.0.0.1', port: 41000 }] } },
        },
        db: {
          name: 'db',
          id: () => 'def456',
          data: { ports: [{ hostPort: 5432, containerPort: 5432 }] },
          state: { current: { type: 'running' } },
        },
      },
    }) as any

  it('publishes the ports of endpoints on a free port of the loopback interface, and nothing else', () => {
    const workTree = tree()
    publishEndpoints(workTree, [{ service: 'web', port: 80 }], false)
    expect(workTree.services.web.data.ports).toEqual([
      { containerPort: 80, hostPort: 0, hostIp: '127.0.0.1' },
      { containerPort: 9229, hostPort: null },
    ])
    expect(workTree.services.db.data.ports).toEqual([{ containerPort: 5432, hostPort: null }])
  })

  it('publishes nothing on a cluster', () => {
    const workTree = tree()
    publishEndpoints(workTree, [{ service: 'web', port: 80 }], true)
    expect(workTree.services.web.data.ports[0]).toEqual({ containerPort: 80, hostPort: null })
  })

  it('answers where the endpoints are once every service is up', () => {
    const workTree = tree()
    const up = { services: ['web', 'db'], endpoints: [{ service: 'web', port: 80 }] }
    expect(getEndpointTargets(workTree, up, undefined)).toEqual([
      { service: 'web', port: 80, address: { host: '127.0.0.1', port: 41000 } },
    ])
    workTree.services.db.state.current = { type: 'starting' }
    expect(getEndpointTargets(workTree, up, undefined)).toBeNull()
    workTree.services.db.state.current = { type: 'running' }
    expect(getEndpointTargets(workTree, up, { namespace: 'hk-0123' } as any)).toEqual([
      { service: 'web', port: 80, address: { host: 'web-abc123.hk-0123.svc', port: 80 } },
    ])
  })
})

describe('endpoints config', () => {
  const base = {
    issuers: [{ issuer: ISS, audience: 'hammerkit' }],
    runs: { env: { allow: ['PATH'] } },
  }
  const issue = (config: object) => {
    const parsed = serverConfigSchema.safeParse({ ...base, ...config })
    return parsed.success ? null : parsed.error.issues[0].message
  }

  it('wants the certificate of the endpoints where tokens would go in the clear', () => {
    expect(issue({ endpoints: { domain: 'run.example.com' } })).toBeNull()
    expect(
      issue({ listen: { host: '0.0.0.0' }, behindTlsProxy: true, endpoints: { domain: 'run.example.com' } })
    ).toBeNull()
    expect(
      issue({ listen: { host: '0.0.0.0' }, tls: { cert: 'c', key: 'k' }, endpoints: { domain: 'run.example.com' } })
    ).toMatch(/endpoints.tls/)
    expect(
      issue({
        listen: { host: '0.0.0.0' },
        behindTlsProxy: true,
        endpoints: { domain: 'run.example.com', tls: { cert: 'c', key: 'k' } },
      })
    ).toMatch(/proxy holds the certificate/)
  })

  it('signs in with an issuer the server accepts', () => {
    expect(
      issue({ endpoints: { domain: 'run.example.com', login: { issuer: 'https://else', clientId: 'c' } } })
    ).toMatch(/not one of the accepted issuers/)
    expect(issue({ endpoints: { domain: 'Run.Example.com' } })).toMatch(/lower case/)
  })

  it('keeps the ttl below maxTtl', () => {
    expect(issue({ runs: { env: { allow: ['PATH'] }, up: { ttl: '4d', maxTtl: '3d' } } })).toMatch(/more than maxTtl/)
  })
})

describe('the namespace of a service run', () => {
  it('is a namespace of the server, apart from the caller one', () => {
    const name = getServiceRunNamespace('hk-', 'run_abc')
    expect(isCallerNamespace('hk-', name)).toBe(true)
    expect(name).not.toBe(getServiceRunNamespace('hk-', 'run_abd'))
  })

  it('lets the server in, to the ports of the endpoints only', () => {
    expect(getServerIngressPolicy('hk-0123', 'hammerkit', [8080, 8080, 3000]).spec).toEqual({
      podSelector: {},
      policyTypes: ['Ingress'],
      ingress: [
        {
          _from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'hammerkit' } } }],
          ports: [
            { protocol: 'TCP', port: 8080 },
            { protocol: 'TCP', port: 3000 },
          ],
        },
      ],
    })
    expect(getServerIngressPolicy('hk-0123', 'hammerkit', []).spec?.ingress).toEqual([])
  })

  it('is another one for every wake of the run', () => {
    const names = [0, 1, 2].map((wakes) => getServiceRunNamespace('hk-', 'run_abc', wakes))
    expect(new Set(names).size).toBe(3)
    expect(names[0]).toBe(getServiceRunNamespace('hk-', 'run_abc'))
  })
})
