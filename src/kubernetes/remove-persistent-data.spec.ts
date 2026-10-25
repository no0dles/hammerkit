import { removePersistentData } from './remove-persistent-data'
import { getRunLabelValue } from './job-placement'
import { WorkKubernetesEnvironment } from '../planner/work-environment'

describe('removePersistentData', () => {
  it('removes the data of its own run on a server, and leaves the other run’s', async () => {
    const coreApi = {
      listNamespacedConfigMap: vi.fn(async () => ({ items: [{ metadata: { name: 'map' } }] })),
      deleteNamespacedConfigMap: vi.fn(async () => undefined),
      listNamespacedPersistentVolumeClaim: vi.fn(async () => ({ items: [{ metadata: { name: 'claim' } }] })),
      deleteNamespacedPersistentVolumeClaim: vi.fn(async () => undefined),
    }
    const env = { namespace: 'caller', server: { run: 'run_1' } } as unknown as WorkKubernetesEnvironment
    await removePersistentData({ coreApi } as any, env, { name: 'db', id: () => 'abc123' } as any)

    const labelSelector = `hammerkit.dev/id=abc123,hammerkit.dev/run=${getRunLabelValue('run_1')}`
    expect(coreApi.listNamespacedConfigMap).toHaveBeenCalledWith({ namespace: 'caller', labelSelector })
    expect(coreApi.listNamespacedPersistentVolumeClaim).toHaveBeenCalledWith({ namespace: 'caller', labelSelector })
    expect(coreApi.deleteNamespacedPersistentVolumeClaim).toHaveBeenCalledWith({ name: 'claim', namespace: 'caller' })
  })
})
