import { getStaleItemSelector, removeStaleItems } from './remove-stale-items'
import { getRunLabelValue } from './job-placement'
import { KubernetesInstance } from './kubernetes-instance'
import { WorkKubernetesEnvironment } from '../planner/work-environment'

describe('removeStaleItems', () => {
  it('selects the items of the run that it has no more, never objects without an item', () => {
    const run = getRunLabelValue('run_1')
    expect(getStaleItemSelector('run_1', ['b', 'a', 'b'])).toBe(
      `hammerkit.dev/run=${run},hammerkit.dev/id,hammerkit.dev/id notin (a,b)`
    )
  })

  it('removes what serves or ran for them, but their claims', async () => {
    const calls: string[] = []
    const collection = (kind: string) => async (request: any) => {
      calls.push(`${kind} ${request.labelSelector}`)
    }
    const instance = {
      appsApi: { deleteCollectionNamespacedDeployment: collection('Deployment') },
      batchApi: { deleteCollectionNamespacedJob: collection('Job') },
      coreApi: {
        deleteCollectionNamespacedService: collection('Service'),
        deleteCollectionNamespacedSecret: collection('Secret'),
      },
      objectApi: {
        list: async () => ({ items: [{ metadata: { name: 'policy' } }] }),
        delete: async (spec: any) => calls.push(`${spec.kind} ${spec.metadata.name}`),
      },
    } as unknown as KubernetesInstance
    const env = { namespace: 'hk-run', server: { run: 'run_1' } } as unknown as WorkKubernetesEnvironment
    await removeStaleItems(instance, env, ['a'])
    const selector = getStaleItemSelector('run_1', ['a'])
    expect(calls).toEqual([
      `Deployment ${selector}`,
      `Job ${selector}`,
      `Service ${selector}`,
      `Secret ${selector}`,
      'NetworkPolicy policy',
    ])
  })
})
