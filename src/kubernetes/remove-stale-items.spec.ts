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

  // a cluster whose pods of the selector end after `endAfter` lists of them
  function fakeCluster(endAfter: number) {
    const calls: string[] = []
    const collection = (kind: string) => async (request: any) => {
      calls.push(`${kind} ${request.labelSelector}`)
    }
    let lists = 0
    const instance = {
      appsApi: { deleteCollectionNamespacedDeployment: collection('Deployment') },
      batchApi: { deleteCollectionNamespacedJob: collection('Job') },
      coreApi: {
        deleteCollectionNamespacedService: collection('Service'),
        deleteCollectionNamespacedSecret: collection('Secret'),
        listNamespacedPod: async (request: any) => {
          lists++
          const ended = lists > endAfter
          calls.push(`Pods ${request.labelSelector} ${ended ? 'gone' : 'terminating'}`)
          return { items: ended ? [] : [{ status: { phase: 'Running' } }] }
        },
      },
      objectApi: {
        list: async () => ({ items: [{ metadata: { name: 'policy' } }] }),
        delete: async (spec: any) => calls.push(`${spec.kind} ${spec.metadata.name}`),
      },
    } as unknown as KubernetesInstance
    return { instance, calls }
  }
  const env = { namespace: 'hk-run', server: { run: 'run_1' } } as unknown as WorkKubernetesEnvironment

  it('removes what serves or ran for them, but their claims, and their policies once their pods ended', async () => {
    const { instance, calls } = fakeCluster(1)
    await removeStaleItems(instance, env, ['a'], 5000, 1)
    const selector = getStaleItemSelector('run_1', ['a'])
    expect(calls).toEqual([
      `Deployment ${selector}`,
      `Job ${selector}`,
      `Service ${selector}`,
      `Secret ${selector}`,
      `Pods ${selector} terminating`,
      `Pods ${selector} gone`,
      'NetworkPolicy policy',
    ])
  })

  it('keeps the policies of pods that outlast the wait', async () => {
    const { instance, calls } = fakeCluster(Infinity)
    await expect(removeStaleItems(instance, env, ['a'], 20, 1)).rejects.toThrow(
      'pods of the previous commit are still running, so their network policies stay'
    )
    expect(calls).not.toContain('NetworkPolicy policy')
  })
})
