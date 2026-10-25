import {
  evictKeptClaims,
  EXPIRES_ANNOTATION,
  expireKeptClaims,
  forgetClaimState,
  getClaimName,
  isKeptClaim,
  KEPT_BY_LABEL,
  recordClaimState,
  STATE_ANNOTATION,
  sweepKeptClaims,
  useClaimState,
  VOLUME_SCOPE_LABEL,
} from './kept-claims'
import { getRunLabelValue } from './job-placement'
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
  version?: number
}

// claims of one namespace, which a label selector of `key`, `key=value` and `key!=value` lists
function cluster(claims: Claim[]) {
  const calls: string[] = []
  const notFound = () => Object.assign(new Error('not found'), { code: 404 })
  const metadata = (claim: Claim) => ({
    name: claim.name,
    resourceVersion: String(claim.version ?? 1),
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
      deleteNamespacedPersistentVolumeClaim: async ({ name, body }: any) => {
        const claim = claims.find((c) => c.name === name)
        if (!claim) {
          throw notFound()
        }
        if (body?.preconditions?.resourceVersion !== String(claim.version ?? 1)) {
          throw Object.assign(new Error('the object has been modified'), { code: 409 })
        }
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
        claim.version = (claim.version ?? 1) + 1
        Object.assign(claim.labels, spec.metadata.labels ?? {})
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
    expect(getClaimName(task, {})).toBe(`hammerkit-${'a'.repeat(40)}`)
    // on a server that keeps none, the run's own: the runs of a caller share the namespace
    const own = `hammerkit-${'a'.repeat(32)}-${getRunLabelValue('run_1').substring(0, 8)}`
    expect(getClaimName(task, env())).toBe(own)
    const ref = getClaimName(task, env('ref-1'))
    expect(ref).toMatch(new RegExp(`^hammerkit-${'a'.repeat(40)}-[0-9a-f]{12}$`))
    // a pod's volume name
    expect(ref.length).toBeLessThanOrEqual(63)
    expect(getClaimName(task, env('sandbox-1'))).not.toBe(ref)
    expect(getClaimName(service, env('ref-1'))).toBe(
      `hammerkit-${'b'.repeat(32)}-${getRunLabelValue('run_1').substring(0, 8)}`
    )
    expect([isKeptClaim(task, env('ref-1')), isKeptClaim(task, env()), isKeptClaim(service, env('ref-1'))]).toEqual([
      true,
      false,
      false,
    ])
  })

  it('says the state of the outputs only while they are whole', async () => {
    const { instance, claims } = cluster([
      kept('claim', 'ref-1', { [EXPIRES_ANNOTATION]: '2026-10-18T12:00:00Z' }),
      kept('foreign', 'sandbox-1', { [STATE_ANNOTATION]: 'state-1' }),
    ])
    expect(await useClaimState(instance, env('ref-1'), 'claim')).toBeNull()
    // the run that looked at it holds it: it does not expire before the run's end
    expect(claims[0].labels[KEPT_BY_LABEL]).toBe(getRunLabelValue('run_1'))
    expect(claims[0].annotations).toEqual({})
    await recordClaimState(instance, env('ref-1'), 'claim', 'state-1')
    expect(await useClaimState(instance, env('ref-1'), 'claim')).toBe('state-1')
    expect(await forgetClaimState(instance, env('ref-1'), 'claim')).toBe(true)
    expect(claims[0].annotations).toEqual({})
    // one that is being removed holds nothing to mount
    claims[0].annotations[STATE_ANNOTATION] = 'state-1'
    claims[0].deleting = true
    expect(await useClaimState(instance, env('ref-1'), 'claim')).toBeNull()
    // nor one of another source
    expect(await useClaimState(instance, env('ref-1'), 'foreign')).toBeNull()
    // a claim that is not there was not left by a run
    expect(await forgetClaimState(instance, env('ref-1'), 'other')).toBe(false)
    expect(await useClaimState(instance, env('ref-1'), 'other')).toBeNull()
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

  it('leaves the kept claims of a scope a run executes in, expired or not', async () => {
    const now = new Date('2026-10-18T12:00:00Z')
    const { instance, calls } = cluster([
      kept('expired', 'ref-1', { [EXPIRES_ANNOTATION]: '2026-10-18T11:59:59Z' }),
      // mounted by the run on the sandbox, which cleared its expiry
      kept('mounted', 'sandbox-1', {}, 'run-b'),
      kept('due', 'sandbox-1', { [EXPIRES_ANNOTATION]: '2026-10-18T11:00:00Z' }),
    ])
    const swept = await sweepKeptClaims(instance, 'ns', {
      now,
      keep: true,
      timeout: 1000,
      inUse: new Set(['sandbox-1']),
    })
    expect(swept).toEqual({ removed: ['expired'], next: null })
    expect(calls).toEqual(['delete expired'])
  })

  it('makes way under a quota by removing the kept claims the run did not take', async () => {
    const run = getRunLabelValue('run_1')
    const released = { [EXPIRES_ANNOTATION]: '2026-01-01T00:00:00.000Z' }
    const { instance, claims } = cluster([
      kept('mine', 'ref-1', {}, run),
      // of a task renamed since, which no task of the run takes
      kept('renamed', 'ref-1'),
      kept('other', 'sandbox-1', released),
      kept('third', 'ref-2', released),
      // mounted by a run on another sandbox that executes now: it has no expiry yet
      kept('busy', 'sandbox-2', {}, getRunLabelValue('run_2')),
    ])
    expect(await evictKeptClaims(instance, env('ref-1'), 1000)).toEqual(['renamed', 'other', 'third'])
    expect(claims.map((c) => c.name)).toEqual(['mine', 'busy'])
    expect(await evictKeptClaims(instance, env(), 1000)).toEqual([])
  })

  it('leaves a claim a run took between the listing and the removal', async () => {
    const { instance, claims } = cluster([kept('taken', 'ref-1'), kept('idle', 'ref-1')])
    const list = instance.coreApi.listNamespacedPersistentVolumeClaim
    instance.coreApi.listNamespacedPersistentVolumeClaim = async (request: any) => {
      const listed = await list(request)
      // a task of the run finds its outputs in it right after
      await useClaimState(instance, env('ref-1'), 'taken')
      return listed
    }
    expect(await evictKeptClaims(instance, env('ref-1'), 1000)).toEqual(['idle'])
    expect(claims.map((c) => c.name)).toEqual(['taken'])
  })
})
