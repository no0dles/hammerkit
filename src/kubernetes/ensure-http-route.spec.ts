import { ensureHttpRoute } from './ensure-http-route'
import { KubernetesInstance } from './kubernetes-instance'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { BuildFileEnvironmentSchemaIngress } from '../schema/build-file-environment-schema-ingress'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'

function httpError(statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(`http ${statusCode}`), { statusCode })
}

function makeInstance(
  objectApi: Partial<{ read: jest.Mock; patch: jest.Mock; create: jest.Mock }>
): KubernetesInstance {
  return { objectApi } as any
}

const env = { type: 'kubernetes', namespace: 'demo', context: 'ctx', ingresses: [] } as WorkKubernetesEnvironment

const service = {
  name: 'api',
  id: () => 'abc123',
  data: { ports: [{ containerPort: 3000, hostPort: null }] },
} as unknown as WorkItem<ContainerWorkService>

function ingress(overrides: Partial<BuildFileEnvironmentSchemaIngress> = {}): BuildFileEnvironmentSchemaIngress {
  return {
    kind: 'httproute',
    host: 'api.example.com',
    service: 'api',
    gateway: 'web',
    ...overrides,
  } as BuildFileEnvironmentSchemaIngress
}

describe('ensureHttpRoute', () => {
  it('creates an HTTPRoute with the expected shape', async () => {
    const read = jest.fn().mockRejectedValue(httpError(404))
    const create = jest.fn().mockResolvedValue({ body: {} })
    await ensureHttpRoute(makeInstance({ read, create }), env, ingress(), service)

    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][0]).toMatchObject({
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
      metadata: { name: 'api.example.com', namespace: 'demo', labels: { 'hammerkit.dev/id': 'abc123' } },
      spec: {
        parentRefs: [{ name: 'web' }],
        hostnames: ['api.example.com'],
        rules: [
          {
            matches: [{ path: { type: 'PathPrefix', value: '/' } }],
            backendRefs: [{ name: 'api-abc123', port: 3000 }],
          },
        ],
      },
    })
  })

  it('uses servicePort, path and gatewayNamespace when provided', async () => {
    const read = jest.fn().mockRejectedValue(httpError(404))
    const create = jest.fn().mockResolvedValue({ body: {} })
    await ensureHttpRoute(
      makeInstance({ read, create }),
      env,
      ingress({ servicePort: 8080, path: '/api', gatewayNamespace: 'gateways' }),
      service
    )

    expect(create.mock.calls[0][0]).toMatchObject({
      spec: {
        parentRefs: [{ name: 'web', namespace: 'gateways' }],
        rules: [
          {
            matches: [{ path: { type: 'PathPrefix', value: '/api' } }],
            backendRefs: [{ name: 'api-abc123', port: 8080 }],
          },
        ],
      },
    })
  })

  it('throws when no gateway is set', async () => {
    const read = jest.fn()
    const create = jest.fn()
    await expect(
      ensureHttpRoute(makeInstance({ read, create }), env, ingress({ gateway: undefined }), service)
    ).rejects.toThrow(/requires a "gateway"/)
    expect(create).not.toHaveBeenCalled()
  })
})
