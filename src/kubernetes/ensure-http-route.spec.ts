import type { Mock } from 'vitest'
import { ApiException } from '@kubernetes/client-node'
import { ensureHttpRoute } from './ensure-http-route'
import { KubernetesInstance } from './kubernetes-instance'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { BuildFileEnvironmentSchemaHttpRoute } from '../schema/build-file-environment-schema-http-route'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'

function httpError(code: number): ApiException<undefined> {
  return new ApiException(code, `http ${code}`, undefined, {})
}

function makeInstance(objectApi: Partial<{ read: Mock; patch: Mock; create: Mock }>): KubernetesInstance {
  return { objectApi } as any
}

const env = { type: 'kubernetes', namespace: 'demo', context: 'ctx', httpRoutes: [] } as WorkKubernetesEnvironment

const service = {
  name: 'api',
  id: () => 'abc123',
  data: { ports: [{ containerPort: 3000, hostPort: null }] },
} as unknown as WorkItem<ContainerWorkService>

function route(overrides: Partial<BuildFileEnvironmentSchemaHttpRoute> = {}): BuildFileEnvironmentSchemaHttpRoute {
  return {
    host: 'api.example.com',
    service: 'api',
    gateway: 'web',
    ...overrides,
  }
}

describe('ensureHttpRoute', () => {
  it('creates an HTTPRoute with the expected shape', async () => {
    const read = vi.fn().mockRejectedValue(httpError(404))
    const create = vi.fn().mockResolvedValue({})
    await ensureHttpRoute(makeInstance({ read, create }), env, route(), service)

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
    const read = vi.fn().mockRejectedValue(httpError(404))
    const create = vi.fn().mockResolvedValue({})
    await ensureHttpRoute(
      makeInstance({ read, create }),
      env,
      route({ servicePort: 8080, path: '/api', gatewayNamespace: 'gateways' }),
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
})
