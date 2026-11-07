import { ServiceRollouts } from './service-rollouts'

describe('ServiceRollouts', () => {
  it('puts back what was replaced as it was first, and removes what was made', async () => {
    const rollouts = new ServiceRollouts()
    const first = { metadata: { labels: { a: '1' } }, spec: { replicas: 1 } }
    rollouts.add('hk-run', 'api', first as any)
    // a second rollout of the same Deployment keeps the first state
    rollouts.add('hk-run', 'api', { metadata: {}, spec: { replicas: 2 } } as any)
    rollouts.add('hk-run', 'web', undefined)
    const replaced: any[] = []
    const deleted: string[] = []
    const instance = {
      objectApi: {
        read: async () => ({ metadata: { resourceVersion: '3' } }),
        replace: async (spec: any) => {
          replaced.push(spec)
          return spec
        },
      },
      appsApi: {
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
    expect(replaced).toHaveLength(1)
    expect(replaced[0]).toMatchObject({
      metadata: { name: 'api', namespace: 'hk-run', labels: { a: '1' } },
      spec: first.spec,
    })
    expect(deleted).toEqual(['web'])
    expect(said).toEqual(['putting api back as it was', 'removing web, which it made'])
    expect(rollouts.size).toBe(0)
  })
})
