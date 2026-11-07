import { ServiceRollouts } from './service-rollouts'

describe('ServiceRollouts', () => {
  it('puts back what was replaced as it was first, and removes what was made', async () => {
    const rollouts = new ServiceRollouts()
    const first = { metadata: { labels: { a: '1' } }, spec: { replicas: 1 } }
    rollouts.add('hk-run', 'api', first as any)
    // a second rollout of the same Deployment keeps the first state
    rollouts.add('hk-run', 'api', { metadata: {}, spec: { replicas: 2 } } as any)
    rollouts.add('hk-run', 'web', undefined)
    // a service that watches its files got the new ones: they go back before its Deployment
    const restored: string[] = []
    rollouts.add('hk-run', 'dev', { metadata: {}, spec: { replicas: 1 } } as any, async () => {
      restored.push('dev')
    })
    const replaced: any[] = []
    const deleted: string[] = []
    const instance = {
      appsApi: {
        readNamespacedDeployment: async () => ({ metadata: { resourceVersion: '3' } }),
        patchNamespacedDeployment: async ({ name, namespace, body }: any) => {
          const at = (path: string) => body.find((op: any) => op.path === path).value
          const spec = { metadata: { name, namespace, labels: at('/metadata/labels') }, spec: at('/spec') }
          replaced.push(spec)
          return spec
        },
        deleteNamespacedDeployment: async ({ name }: any) => {
          deleted.push(name)
          if (name === 'web') {
            throw Object.assign(new Error('gone'), { code: 404 })
          }
        },
      },
    } as any
    const said: string[] = []
    await rollouts.undo(instance, (text) => said.push(text))
    expect(replaced).toHaveLength(2)
    expect(restored).toEqual(['dev'])
    expect(replaced[0]).toMatchObject({
      metadata: { name: 'api', namespace: 'hk-run', labels: { a: '1' } },
      spec: first.spec,
    })
    expect(deleted).toEqual(['web'])
    expect(said).toEqual([
      'putting api back as it was',
      'removing web, which it made',
      'putting the files of dev back as they were',
      'putting dev back as it was',
    ])
    expect(rollouts.size).toBe(0)
  })
})
