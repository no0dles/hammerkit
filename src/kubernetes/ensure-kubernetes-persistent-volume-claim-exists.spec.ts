import {
  ensureKubernetesPersistentVolumeClaimExists,
  getClaimSize,
} from './ensure-kubernetes-persistent-volume-claim-exists'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { getRunLabelValue } from './job-placement'
import { EXPIRES_ANNOTATION, KEPT_BY_LABEL, VOLUME_SCOPE_LABEL } from './kept-claims'

const env = {
  type: 'kubernetes',
  namespace: 'ns',
  httpRoutes: [],
  networkPolicyEnforced: false,
} as WorkKubernetesEnvironment
const volume = { name: 'hammerkit-install', persistentVolumeClaim: { claimName: 'hammerkit-install' } }
const install = { id: () => 'install', name: 'install', status: { write: () => undefined } } as any

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

describe('the kept claim of a task', () => {
  const server = {
    ...env,
    server: { run: 'run_1', namespace: 'hammerkit', pools: [], providers: {}, accounts: {}, volumeScope: 'ref-1' },
  } as WorkKubernetesEnvironment
  const runLabel = getRunLabelValue('run_1')

  function keptCluster(existing: any, options: { quotaFull?: boolean } = {}) {
    let claim = existing
    let quotaFull = !!options.quotaFull
    const calls: string[] = []
    const notFound = () => Object.assign(new Error('not found'), { code: 404 })
    // released by its last run, so it has an expiry
    const other = {
      metadata: {
        name: 'hammerkit-other',
        labels: { [VOLUME_SCOPE_LABEL]: 'sandbox-1' },
        annotations: { [EXPIRES_ANNOTATION]: '2026-01-01T00:00:00.000Z' },
      },
    }
    let others = [other]
    const instance = {
      objectApi: {
        read: async () => claim ?? Promise.reject(notFound()),
        create: async (spec: any) => {
          if (quotaFull) {
            throw Object.assign(new Error('persistentvolumeclaims "x" is forbidden: exceeded quota: hammerkit'), {
              code: 403,
            })
          }
          calls.push(`create ${JSON.stringify(spec.metadata.labels)}`)
          claim = spec
          return spec
        },
        patch: async (spec: any) => {
          calls.push(`patch ${JSON.stringify(spec.metadata)}`)
          claim = {
            ...claim,
            metadata: { ...claim.metadata, labels: { ...claim.metadata.labels, ...spec.metadata.labels } },
          }
          return claim
        },
      },
      coreApi: {
        listNamespacedPersistentVolumeClaim: async () => ({ items: others }),
        deleteNamespacedPersistentVolumeClaim: async ({ name }: any) => {
          calls.push(`delete ${name}`)
          others = []
          quotaFull = false
        },
        readNamespacedPersistentVolumeClaim: async () => Promise.reject(notFound()),
      },
    } as any
    return { instance, calls }
  }

  it('carries the scope and the run that mounts it, not the run label', async () => {
    const { instance, calls } = keptCluster(null)
    await ensureKubernetesPersistentVolumeClaimExists(instance, server, volume, install, null, true)
    expect(calls).toEqual([
      `create ${JSON.stringify({
        'hammerkit.dev/id': 'install',
        [VOLUME_SCOPE_LABEL]: 'ref-1',
        [KEPT_BY_LABEL]: runLabel,
      })}`,
    ])
    // one that is not kept, a service's, is the run's
    const run = keptCluster(null)
    await ensureKubernetesPersistentVolumeClaimExists(run.instance, server, volume, install, null)
    expect(run.calls).toEqual([
      `create ${JSON.stringify({ 'hammerkit.dev/id': 'install', 'hammerkit.dev/run': runLabel })}`,
    ])
  })

  it('does not expire while a run mounts it again', async () => {
    const { instance, calls } = keptCluster({
      metadata: {
        name: volume.name,
        labels: { [VOLUME_SCOPE_LABEL]: 'ref-1', [KEPT_BY_LABEL]: 'earlier' },
        annotations: { [EXPIRES_ANNOTATION]: '2026-10-18T12:00:00Z' },
      },
      spec: { resources: { requests: { storage: '1Gi' } } },
    })
    await ensureKubernetesPersistentVolumeClaimExists(instance, server, volume, install, null, true)
    expect(calls).toEqual([
      `patch ${JSON.stringify({
        name: volume.name,
        namespace: 'ns',
        labels: { [KEPT_BY_LABEL]: runLabel },
        annotations: { [EXPIRES_ANNOTATION]: null },
      })}`,
    ])
  })

  it('is never one another source kept', async () => {
    const { instance } = keptCluster({
      metadata: { name: volume.name, labels: { [VOLUME_SCOPE_LABEL]: 'sandbox-1', [KEPT_BY_LABEL]: 'earlier' } },
      spec: { resources: { requests: { storage: '1Gi' } } },
    })
    await expect(
      ensureKubernetesPersistentVolumeClaimExists(instance, server, volume, install, null, true)
    ).rejects.toThrow(`the claim ${volume.name} is not one this run may mount, it was made for another source`)
  })

  it('makes room under the quota with the kept claims of other sources', async () => {
    const { instance, calls } = keptCluster(null, { quotaFull: true })
    await ensureKubernetesPersistentVolumeClaimExists(instance, server, volume, install, null, true)
    expect(calls).toEqual([
      'delete hammerkit-other',
      `create ${JSON.stringify({
        'hammerkit.dev/id': 'install',
        [VOLUME_SCOPE_LABEL]: 'ref-1',
        [KEPT_BY_LABEL]: runLabel,
      })}`,
    ])
  })
})
