import {
  evictKeptClaims,
  EXPIRES_ANNOTATION,
  expireKeptClaims,
  forgetClaimState,
  getClaimName,
  isKeptClaim,
  KEPT_BY_LABEL,
  readClaimState,
  recordClaimState,
  STATE_ANNOTATION,
  sweepKeptClaims,
  VOLUME_SCOPE_LABEL,
} from './kept-claims'
import { WorkKubernetesEnvironment } from '../planner/work-environment'

const env = (volumeScope?: string) =>
  ({
    type: 'kubernetes',
    namespace: 'ns',
    httpRoutes: [],
    networkPolicyEnforced: false,
    server: { run: 'run_1', namespace: 'hammerkit', pools: [], providers: {}, accounts: {}, volumeScope },
  }) as WorkKubernetesEnvironment
const task = { id: () => 'a'.repeat(40), data: { type: 'container-task' } } as any
const service = { id: () => 'b'.repeat(40), data: { type: 'container-service' } } as any

interface Claim {
  name: string
  labels: { [key: string]: string }
  annotations: { [key: string]: string }
  deleting?: boolean
}

// claims of one namespace, which a label selector of `key`, `key=value` and `key!=value` lists
function cluster(claims: Claim[]) {
  const calls: string[] = []
  const notFound = () => Object.assign(new Error('not found'), { code: 404 })
  const metadata = (claim: Claim) => ({
    name: claim.name,
    labels: claim.labels,
    annotations: claim.annotations,
    ...(claim.deleting ? { deletionTimestamp: new Date() } : {}),
  })
  const matches = (claim: Claim, selector: string) =>
    selector.split(',').every((term) => {
      const [key, value] = term.split(/!?=/)
      if (term.includes('!=')) {
        return claim.labels[key] !== value
      }
      return value === undefined ? key in claim.labels : claim.labels[key] === value
    })
  const instance = {
    coreApi: {
      readNamespacedPersistentVolumeClaim: async ({ name }: any) => {
        const claim = claims.find((c) => c.name === name)
        return claim ? { metadata: metadata(claim) } : Promise.reject(notFound())
      },
      listNamespacedPersistentVolumeClaim: async ({ labelSelector }: any) => ({
        items: claims.filter((c) => matches(c, labelSelector)).map((c) => ({ metadata: metadata(c) })),
      }),
      deleteNamespacedPersistentVolumeClaim: async ({ name }: any) => {
        calls.push(`delete ${name}`)
        claims.splice(
          claims.findIndex((c) => c.name === name),
          1
        )
      },
    },
    objectApi: {
      patch: async (spec: any) => {
        const claim = claims.find((c) => c.name === spec.metadata.name)
        if (!claim) {
          throw notFound()
        }
        calls.push(`annotate ${claim.name} ${JSON.stringify(spec.metadata.annotations)}`)
        for (const [key, value] of Object.entries(spec.metadata.annotations ?? {})) {
          if (value === null) {
            delete claim.annotations[key]
          } else {
            claim.annotations[key] = value as string
          }
        }
        return { metadata: metadata(claim) }
      },
    },
  } as any
  return { instance, calls, claims }
}

const kept = (name: string, scope: string, annotations: { [key: string]: string } = {}, by = 'run-a'): Claim => ({
  name,
  labels: { [VOLUME_SCOPE_LABEL]: scope, [KEPT_BY_LABEL]: by },
  annotations,
})

describe('kept claims', () => {
  it('names the claim of a task by the scope of the run, and keeps only those of tasks', () => {
    expect(getClaimName(task)).toBe(`hammerkit-${'a'.repeat(40)}`)
    expect(getClaimName(task, env())).toBe(`hammerkit-${'a'.repeat(40)}`)
    const ref = getClaimName(task, env('ref-1'))
    expect(ref).toMatch(new RegExp(`^hammerkit-${'a'.repeat(40)}-[0-9a-f]{12}$`))
    // a pod's volume name
    expect(ref.length).toBeLessThanOrEqual(63)
    expect(getClaimName(task, env('sandbox-1'))).not.toBe(ref)
    expect(getClaimName(service, env('ref-1'))).toBe(`hammerkit-${'b'.repeat(40)}`)
    expect([isKeptClaim(task, env('ref-1')), isKeptClaim(task, env()), isKeptClaim(service, env('ref-1'))]).toEqual([
      true,
      false,
      false,
    ])
  })

  it('says the state of the outputs only while they are whole', async () => {
    const { instance, claims } = cluster([kept('claim', 'ref-1')])
    expect(await readClaimState(instance, env('ref-1'), 'claim')).toBeNull()
    await recordClaimState(instance, env('ref-1'), 'claim', 'state-1')
    expect(await readClaimState(instance, env('ref-1'), 'claim')).toBe('state-1')
    expect(await forgetClaimState(instance, env('ref-1'), 'claim')).toBe(true)
    expect(claims[0].annotations).toEqual({})
    // one that is being removed holds nothing to mount
    claims[0].annotations[STATE_ANNOTATION] = 'state-1'
    claims[0].deleting = true
    expect(await readClaimState(instance, env('ref-1'), 'claim')).toBeNull()
    // a claim that is not there was not left by a run
    expect(await forgetClaimState(instance, env('ref-1'), 'other')).toBe(false)
    expect(await readClaimState(instance, env('ref-1'), 'other')).toBeNull()
  })

  it('gives the claims a run kept their expiry at its end', async () => {
    const { instance, claims } = cluster([kept('mine', 'ref-1'), kept('earlier', 'ref-1', {}, 'run-b')])
    await expireKeptClaims(instance, 'ns', 'run-a', new Date('2026-10-18T12:15:00Z'))
    expect(claims.map((c) => c.annotations)).toEqual([{ [EXPIRES_ANNOTATION]: '2026-10-18T12:15:00.000Z' }, {}])
  })

  it('removes the claims that expired or that a run left without an expiry, and says when the next expires', async () => {
    const now = new Date('2026-10-18T12:00:00Z')
    const { instance, calls } = cluster([
      kept('expired', 'ref-1', { [EXPIRES_ANNOTATION]: '2026-10-18T11:59:59Z' }),
      kept('later', 'ref-1', { [EXPIRES_ANNOTATION]: '2026-10-18T12:30:00Z' }),
      kept('sooner', 'sandbox-1', { [EXPIRES_ANNOTATION]: '2026-10-18T12:10:00Z' }),
      kept('stopped', 'ref-1'),
      // a claim of a run, the end of the run removes it
      { name: 'run', labels: { 'hammerkit.dev/run': 'run-a' }, annotations: {} },
    ])
    const swept = await sweepKeptClaims(instance, 'ns', { now, keep: true, timeout: 1000 })
    expect(swept).toEqual({ removed: ['expired', 'stopped'], next: new Date('2026-10-18T12:10:00Z') })
    expect(calls).toEqual(['delete expired', 'delete stopped'])

    // a server that keeps no claims any more removes all of them
    const off = await sweepKeptClaims(instance, 'ns', { now, keep: false, timeout: 1000 })
    expect(off).toEqual({ removed: ['later', 'sooner'], next: null })
  })

  it('makes way under a quota by removing the kept claims of other sources only', async () => {
    const { instance, claims } = cluster([kept('mine', 'ref-1'), kept('other', 'sandbox-1'), kept('third', 'ref-2')])
    expect(await evictKeptClaims(instance, env('ref-1'), 1000)).toEqual(['other', 'third'])
    expect(claims.map((c) => c.name)).toEqual(['mine'])
    expect(await evictKeptClaims(instance, env(), 1000)).toEqual([])
  })
})
