import { getServiceIp } from './get-service-ip'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'

const env = { type: 'kubernetes', namespace: 'demo', context: 'ctx', httpRoutes: [] } as WorkKubernetesEnvironment

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
})
