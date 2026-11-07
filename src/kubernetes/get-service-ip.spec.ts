import { getServiceIp } from './get-service-ip'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'

const env = {
  type: 'kubernetes',
  namespace: 'demo',
  context: 'ctx',
  httpRoutes: [],
  networkPolicyEnforced: false,
} as WorkKubernetesEnvironment

const service = {
  name: 'api',
  id: () => 'abc123',
  data: { type: 'container-service' },
} as unknown as WorkItem<ContainerWorkService>

describe('getServiceIp', () => {
  it('returns the clusterIP of the service', async () => {
    const coreApi = {
      readNamespacedService: vi.fn().mockResolvedValue({ spec: { clusterIP: '10.0.0.5' } }),
    }

    await expect(getServiceIp({ coreApi } as any, env, service)).resolves.toBe('10.0.0.5')
    expect(coreApi.readNamespacedService).toHaveBeenCalledWith({ name: 'api-abc123', namespace: 'demo' })
  })

  it('returns null when the service has no spec', async () => {
    const coreApi = {
      readNamespacedService: vi.fn().mockResolvedValue({}),
    }

    await expect(getServiceIp({ coreApi } as any, env, service)).resolves.toBeNull()
  })

  it('returns the address of the ready pod of a headless service', async () => {
    const pod = (ip: string, ready: boolean, deleting = false) => ({
      metadata: deleting ? { deletionTimestamp: new Date() } : {},
      status: { podIP: ip, conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }] },
    })
    const coreApi = {
      readNamespacedService: vi.fn().mockResolvedValue({ spec: { clusterIP: 'None' } }),
      listNamespacedPod: vi
        .fn()
        .mockResolvedValue({ items: [pod('10.1.0.1', true, true), pod('10.1.0.2', false), pod('10.1.0.3', true)] }),
    }

    await expect(getServiceIp({ coreApi } as any, env, service)).resolves.toBe('10.1.0.3')
    expect(coreApi.listNamespacedPod).toHaveBeenCalledWith({
      namespace: 'demo',
      labelSelector: 'hammerkit.dev/id=abc123',
    })
  })

  it('returns null for a headless service without a pod', async () => {
    const coreApi = {
      readNamespacedService: vi.fn().mockResolvedValue({ spec: { clusterIP: 'None' } }),
      listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
    }

    await expect(getServiceIp({ coreApi } as any, env, service)).resolves.toBeNull()
  })
})
