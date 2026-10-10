import { getKubernetesSecretRefs } from './secrets'
import { WorkSecret } from '../planner/work-secret'

const item = { name: 'build', id: () => 'abc' } as any

function secret(target: WorkSecret['target']): WorkSecret {
  return { source: { type: 'env', name: 'TOKEN' }, target, cache: false, digest: () => '' }
}

// The pod spec only references the item's Secret, so no value is part of a
// Job or Deployment.
describe('getKubernetesSecretRefs', () => {
  it('adds nothing without secrets', () => {
    expect(getKubernetesSecretRefs(item, [])).toEqual({ env: [], mounts: [], volumes: [] })
  })

  it('references env targets by key and needs no volume for them', () => {
    expect(getKubernetesSecretRefs(item, [secret({ type: 'env', name: 'API_TOKEN' })])).toEqual({
      env: [{ name: 'API_TOKEN', valueFrom: { secretKeyRef: { name: 'build-abc-secrets', key: 'secret-0' } } }],
      mounts: [],
      volumes: [],
    })
  })

  it('mounts file targets read-only from one secret volume', () => {
    const refs = getKubernetesSecretRefs(item, [
      secret({ type: 'env', name: 'API_TOKEN' }),
      secret({ type: 'file', path: '/run/secrets/key' }),
    ])
    expect(refs.volumes).toEqual([{ name: 'hammerkit-secrets', secret: { secretName: 'build-abc-secrets' } }])
    expect(refs.mounts).toEqual([
      { name: 'hammerkit-secrets', mountPath: '/run/secrets/key', subPath: 'secret-1', readOnly: true },
    ])
  })
})
