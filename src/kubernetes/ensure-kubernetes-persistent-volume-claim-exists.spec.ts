import {
  ensureKubernetesPersistentVolumeClaimExists,
  getClaimSize,
} from './ensure-kubernetes-persistent-volume-claim-exists'
import { WorkKubernetesEnvironment } from '../planner/work-environment'

const env = {
  type: 'kubernetes',
  namespace: 'ns',
  httpRoutes: [],
  networkPolicyEnforced: false,
} as WorkKubernetesEnvironment
const volume = { name: 'hammerkit-install', persistentVolumeClaim: { claimName: 'hammerkit-install' } }
const install = { id: () => 'install', name: 'install', status: { console: () => undefined } } as any

// a cluster with at most one claim, which can or can not grow
function cluster(existing: string | null, options: { grows: boolean } = { grows: true }) {
  let claim: any = existing
    ? { metadata: { name: volume.name }, spec: { resources: { requests: { storage: existing } } } }
    : null
  const notFound = () => Object.assign(new Error('not found'), { code: 404 })
  const calls: string[] = []
  const instance = {
    objectApi: {
      read: async () => claim ?? Promise.reject(notFound()),
      create: async (spec: any) => {
        calls.push(`create ${spec.spec.resources.requests.storage}`)
        claim = spec
        return spec
      },
      patch: async (spec: any) => {
        calls.push(`patch ${JSON.stringify(spec.spec)}`)
        if (!options.grows) {
          throw Object.assign(new Error('only dynamically provisioned pvc can be resized'), { code: 403 })
        }
        claim = { ...claim, spec: { ...claim.spec, ...spec.spec } }
        return claim
      },
    },
  } as any
  return { instance, calls }
}

describe('the claim of a task', () => {
  it('requests the size of the task, else of the environment, else 1Gi', () => {
    expect(getClaimSize(env, null, 'install')).toBe('1Gi')
    expect(getClaimSize({ ...env, volumeSize: '2Gi' }, null, 'install')).toBe('2Gi')
    expect(getClaimSize({ ...env, volumeSize: '2Gi' }, '10Gi', 'install')).toBe('10Gi')
  })

  it('refuses more than a server allows', () => {
    const server = { ...env, volumeSize: '1Gi', maxVolumeSize: '20Gi' }
    expect(getClaimSize(server, '20Gi', 'install')).toBe('20Gi')
    expect(() => getClaimSize(server, '21Gi', 'install')).toThrow(
      'install asks for a claim of 21Gi, the server allows at most 20Gi'
    )
  })

  it('is made of its size', async () => {
    const { instance, calls } = cluster(null)
    const made = await ensureKubernetesPersistentVolumeClaimExists(instance, env, volume, install, '5Gi')
    expect(calls).toEqual(['create 5Gi'])
    expect(made.spec).toEqual({ accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '5Gi' } } })
  })

  it('grows a claim a run before made smaller, and leaves a larger one', async () => {
    const smaller = cluster('1Gi')
    await ensureKubernetesPersistentVolumeClaimExists(smaller.instance, env, volume, install, '5Gi')
    // the requested size is all of a bound claim that may change
    expect(smaller.calls).toEqual(['patch {"resources":{"requests":{"storage":"5Gi"}}}'])

    // as the cluster may write it back, in bytes
    const larger = cluster(String(10 * 1024 ** 3))
    await ensureKubernetesPersistentVolumeClaimExists(larger.instance, env, volume, install, '5Gi')
    const same = cluster('1Gi')
    await ensureKubernetesPersistentVolumeClaimExists(same.instance, env, volume, install, null)
    expect([...larger.calls, ...same.calls]).toEqual([])
  })

  it('says what to do when the storage class can not grow it', async () => {
    const { instance } = cluster('1Gi', { grows: false })
    await expect(ensureKubernetesPersistentVolumeClaimExists(instance, env, volume, install, '5Gi')).rejects.toThrow(
      'the claim hammerkit-install has 1Gi and install needs 5Gi, which its storage class could not grow it to ' +
        '(only dynamically provisioned pvc can be resized): remove it with hammerkit clean and run again'
    )
  })
})
