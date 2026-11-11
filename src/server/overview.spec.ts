import { RunExecutor, RunRegistry } from './runs'
import {
  filterRuns,
  getOverview,
  maySee,
  parseRunFilter,
  runActions,
  toListedRun,
  Viewer,
  visibleCapacity,
} from './overview'
import { Grant } from './policy'

const alice = { iss: 'https://idp.corp', sub: 'alice' }
const bob = { iss: 'https://idp.corp', sub: 'bob' }
const carol = { iss: 'https://idp.corp', sub: 'carol' }
const spec = {
  definition: 'sha256:' + 'a'.repeat(64),
  tasks: ['build'],
  accounts: [] as string[],
  source: { type: 'ref' as const, repo: 'github.com/corp/payments', ref: 'main', commit: 'c'.repeat(40) },
  options: { args: ['--secret-flag'] },
  plan: {},
}
const service = (name: string) => ({
  ...spec,
  tasks: [],
  up: { services: ['web'], ttl: 60 * 60 * 1000, name, endpoints: [] },
})

function manual() {
  const pending: { resolve: () => void }[] = []
  const executor: RunExecutor = {
    execute: (_run, context) =>
      new Promise<void>((resolve, reject) => {
        pending.push({ resolve })
        context.signal.addEventListener('abort', () => reject(new Error('aborted')))
      }),
  }
  return { executor, pending }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

function grant(extra: Partial<Grant> = {}): Grant {
  return {
    accounts: {},
    repos: [],
    builds: 'run',
    sandboxes: [],
    endpoints: [],
    checks: false,
    observe: false,
    matched: [0],
    ...extra,
  }
}

const viewer = (principal: { iss: string; sub: string }, extra: Partial<Grant> = {}): Viewer => ({
  principal,
  grant: grant(extra),
})

describe('RunRegistry wait reasons', () => {
  it('says a queued run waits for a free place, and for its owner’s running limit first', async () => {
    const { executor } = manual()
    const registry = new RunRegistry({ executor, maxConcurrent: 2, limits: { waiting: 5, queued: 5, running: 1 } })
    const a1 = registry.submit(alice, spec)
    const b1 = registry.submit(bob, spec)
    const a2 = registry.submit(alice, spec)
    const c1 = registry.submit(carol, spec)
    await tick()
    expect(registry.peek(a1.id)?.state).toBe('running')
    expect(registry.peek(b1.id)?.state).toBe('running')
    // alice has her one place: a free place would not start it
    expect(registry.queued(a2.id)).toEqual({ position: 1, waitsFor: { type: 'own-limit', running: 1, limit: 1 } })
    expect(registry.queued(c1.id)).toEqual({ position: 2, waitsFor: { type: 'place', used: 2, max: 2 } })
    expect(registry.queued(a1.id)).toBeUndefined()
  })

  it('names the run on the same sandbox, and the run that holds what it needs', async () => {
    const { executor } = manual()
    const sandboxSpec = {
      ...spec,
      source: {
        type: 'sandbox' as const,
        id: 'sbx_aaaaaaaaaaaaaaaa',
        repo: 'github.com/corp/x',
        commit: 'c',
        tree: 't',
      },
    }
    const registry = new RunRegistry({
      executor: { ...executor, exclusive: (run) => (run.tasks[0] === 'deploy' ? 'deploy' : undefined) },
      maxConcurrent: 4,
    })
    const first = registry.submit(alice, sandboxSpec)
    const second = registry.submit(alice, sandboxSpec)
    const deploy = registry.submit(bob, { ...spec, tasks: ['deploy'] })
    const deployAgain = registry.submit(carol, { ...spec, tasks: ['deploy'] })
    await tick()
    expect(registry.queued(second.id)?.waitsFor).toEqual({ type: 'sandbox', run: first.id })
    expect(registry.queued(deployAgain.id)?.waitsFor).toEqual({ type: 'held', run: deploy.id })
  })

  it('counts the runs of each limit as the limits do, and service runs while they sleep or start', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({
      executor,
      maxConcurrent: 1,
      limits: { waiting: 5, queued: 5, running: 5 },
      up: { maxTtl: 60 * 60 * 1000, perCaller: 3, total: 10 },
    })
    const running = registry.submit(alice, spec)
    const queued = registry.submit(alice, spec)
    const waiting = registry.submit(alice, spec, ['prod'])
    const services = registry.submit(alice, service('pr-1'))
    registry.submit(bob, spec)
    await tick()
    expect(registry.usage(alice)).toEqual({
      waiting: [waiting.id],
      queued: [queued.id, services.id],
      running: [running.id],
      services: [services.id],
      asleep: [],
    })
    pending[0].resolve()
    await tick()
    expect(registry.usage(alice).running).toEqual([queued.id])
    const snapshot = registry.snapshot()
    expect(snapshot.places).toEqual({ max: 1, used: 1 })
    expect(snapshot.awaiting.runs.map((run) => run.id)).toEqual([waiting.id])
    expect(snapshot.services).toMatchObject({ max: 10, perCaller: 3, taken: 1 })
    expect(snapshot.services.runs.map((run) => run.id)).toEqual([services.id])
    // a new run of the name replaces the old one once it is up: both take one place, the newest's
    const again = registry.submit(alice, service('pr-1'))
    expect(registry.usage(alice).services).toEqual([again.id])
    expect(registry.snapshot().services).toMatchObject({ taken: 1 })
    expect(registry.snapshot().services.runs.map((run) => run.id)).toEqual([services.id, again.id])
  })
})

describe('overview', () => {
  async function busyServer() {
    const { executor } = manual()
    const registry = new RunRegistry({
      executor,
      maxConcurrent: 2,
      limits: { waiting: 3, queued: 4, running: 1 },
      up: { maxTtl: 60 * 60 * 1000, perCaller: 2, total: 5 },
    })
    const mine = registry.submit(alice, spec)
    const theirs = registry.submit(bob, spec)
    const mineQueued = registry.submit(alice, spec)
    const theirsQueued = registry.submit(bob, spec)
    const approval = registry.submit(bob, { ...spec, accounts: ['prod'] }, ['prod'])
    const preview = registry.submit(carol, service('pr-7'))
    await tick()
    return { registry, mine, theirs, mineQueued, theirsQueued, approval, preview }
  }

  it('shows the caller their runs, and others only as places of the queue', async () => {
    const { registry, mine, mineQueued } = await busyServer()
    const overview = getOverview(registry.snapshot(), registry.usage(alice), viewer(alice))
    expect(overview.you).toEqual({ ...alice, observe: false })
    expect(overview.places).toMatchObject({ max: 2, used: 2, others: 1 })
    expect(overview.places.runs.map((run) => run.id)).toEqual([mine.id])
    // their own runs keep their options
    expect(overview.places.runs[0].options).toEqual({ args: ['--secret-flag'] })
    expect(overview.queue).toEqual([
      {
        position: 1,
        mine: true,
        run: expect.objectContaining({
          id: mineQueued.id,
          queue: { position: 1, waitsFor: { type: 'own-limit', running: 1, limit: 1 } },
        }),
        waitsFor: { type: 'own-limit', running: 1, limit: 1 },
      },
      { position: 2, mine: false, waitsFor: { type: 'own-limit', running: 1, limit: 1 } },
      { position: 3, mine: false, waitsFor: { type: 'place', used: 2, max: 2 } },
    ])
    expect(overview.approvals).toEqual({ waiting: 1, max: 100, runs: [] })
    expect(overview.services).toEqual({ open: 1, max: 5, runs: [] })
    expect(overview.limits).toEqual({
      waiting: { used: 0, limit: 3, runs: [] },
      queued: { used: 1, limit: 4, runs: [mineQueued.id] },
      running: { used: 1, limit: 1, runs: [mine.id] },
      services: { used: 0, limit: 2, runs: [] },
      asleep: { used: 0, runs: [] },
    })
    // nothing of anybody else's runs is in it
    const text = JSON.stringify(overview)
    expect(text).not.toContain('bob')
    expect(text).not.toContain('carol')
  })

  it('shows an approver the runs they decide, and who may open a preview that preview', async () => {
    const { registry, approval, preview } = await busyServer()
    const approver = getOverview(
      registry.snapshot(),
      registry.usage(carol),
      viewer(carol, { accounts: { prod: 'use' } })
    )
    expect(approver.approvals.runs.map((run) => run.id)).toEqual([approval.id])
    expect(approver.approvals.runs[0].owner).toEqual(bob)
    // what the requester chose stays theirs: GET /v1/runs/<id> shows it to an approver
    expect(approver.approvals.runs[0].options).toBeUndefined()
    expect(approver.approvals.runs[0].plan).toBeUndefined()
    expect(approver.approvals.runs[0].readable).toBe(true)

    const opener = getOverview(
      registry.snapshot(),
      registry.usage(alice),
      viewer(alice, { endpoints: [{ repo: 'github.com/corp/*', level: 'open' }] })
    )
    expect(opener.services.runs.map((run) => run.id)).toEqual([preview.id])
    expect(opener.services.runs[0].owner).toEqual(carol)
    expect(opener.approvals.runs).toEqual([])
    // who may only open it reads the run as the lists show it
    expect(opener.services.runs[0].readable).toBeUndefined()
  })

  it('names the owner of a run of somebody else as their token did, when it did', () => {
    const registry = new RunRegistry({ executor: manual().executor })
    const named = registry.submit({ ...carol, claims: { name: 'Carol Danvers', email: 'carol@corp.com' } }, spec)
    const plain = registry.submit(carol, spec)
    expect(toListedRun(viewer(alice), registry.peek(named.id)!).owner).toEqual({ ...carol, name: 'Carol Danvers' })
    expect(toListedRun(viewer(alice), registry.peek(plain.id)!).owner).toEqual(carol)
    // a run's own claims are not kept for that
    expect(registry.peek(named.id)?.owner.claims).toBeUndefined()
  })

  it('names where the build file of a run is, when its version is known', () => {
    const registry = new RunRegistry({ executor: manual().executor })
    const run = registry.peek(registry.submit(carol, spec).id)!
    const entryOf = (definition: string) => (definition === spec.definition ? 'apps/web/build.yaml' : undefined)
    expect(toListedRun(viewer(alice), run, undefined, entryOf).entry).toBe('apps/web/build.yaml')
    expect(toListedRun(viewer(alice), run, undefined, () => undefined).entry).toBeUndefined()
    expect(toListedRun(viewer(alice), run).entry).toBeUndefined()
  })

  it('says whose runs the caller may read whole: of others, who decides and observe', async () => {
    const { registry, mine, theirs, approval } = await busyServer()
    const run = (id: string) => registry.peek(id)!
    // their own runs they always may, and it is not said
    expect(toListedRun(viewer(alice), run(mine.id)).readable).toBeUndefined()
    expect(toListedRun(viewer(alice), run(theirs.id)).readable).toBeUndefined()
    expect(toListedRun(viewer(alice, { observe: true }), run(theirs.id)).readable).toBe(true)
    expect(toListedRun(viewer(alice, { accounts: { prod: 'use' } }), run(approval.id)).readable).toBe(true)
    expect(toListedRun(viewer(alice, { accounts: { prod: 'use' } }), run(theirs.id)).readable).toBeUndefined()
  })

  it('shows every run and its owner to who observes', async () => {
    const { registry, theirs, theirsQueued, approval, preview } = await busyServer()
    const overview = getOverview(registry.snapshot(), registry.usage(carol), viewer(carol, { observe: true }))
    expect(overview.you.observe).toBe(true)
    expect(overview.places.others).toBe(0)
    expect(overview.places.runs.map((run) => run.owner?.sub)).toEqual(['alice', 'bob'])
    expect(overview.queue.map((entry) => entry.run?.id)).toContain(theirsQueued.id)
    expect(overview.approvals.runs.map((run) => run.id)).toEqual([approval.id])
    expect(overview.services.runs.map((run) => run.id)).toEqual([preview.id])
    expect(maySee(viewer(carol, { observe: true }), registry.peek(theirs.id)!)).toBe(true)
  })

  it('names the run a queued run waits for only when the caller may see it', async () => {
    const { executor } = manual()
    const registry = new RunRegistry({
      executor: { ...executor, exclusive: () => 'one' },
      maxConcurrent: 4,
    })
    const bobs = registry.submit(bob, spec)
    const alices = registry.submit(alice, spec)
    await tick()
    const overview = getOverview(registry.snapshot(), registry.usage(alice), viewer(alice))
    expect(overview.queue[0].waitsFor).toEqual({ type: 'held' })
    expect(overview.queue[0].run?.id).toBe(alices.id)
    const observer = getOverview(registry.snapshot(), registry.usage(carol), viewer(carol, { observe: true }))
    expect(observer.queue[0].waitsFor).toEqual({ type: 'held', run: bobs.id })
  })
})

describe('run filters', () => {
  it('reads scope, state and kind, and refuses all without observe', () => {
    expect(parseRunFilter(new URLSearchParams(''), grant())).toEqual({ scope: 'mine' })
    expect(parseRunFilter(new URLSearchParams('scope=visible&state=up,asleep&kind=services'), grant())).toEqual({
      scope: 'visible',
      states: ['up', 'asleep'],
      kind: 'services',
    })
    expect(() => parseRunFilter(new URLSearchParams('scope=all'), grant())).toThrow('observe')
    expect(parseRunFilter(new URLSearchParams('scope=all'), grant({ observe: true }))).toEqual({ scope: 'all' })
    expect(() => parseRunFilter(new URLSearchParams('state=sleeping'), grant())).toThrow('state:')
    expect(() => parseRunFilter(new URLSearchParams('kind=pods'), grant())).toThrow('kind:')
    expect(() => parseRunFilter(new URLSearchParams('scope=everyone'), grant())).toThrow('scope:')
  })

  it('reads since and until as a duration back from now or a time', () => {
    const now = Date.parse('2026-11-08T12:00:00Z')
    expect(parseRunFilter(new URLSearchParams('since=24h'), grant(), now)).toEqual({
      scope: 'mine',
      since: Date.parse('2026-11-07T12:00:00Z'),
    })
    expect(
      parseRunFilter(new URLSearchParams('since=2026-11-01T08:00:00Z&until=2026-11-02T18:30:00Z'), grant(), now)
    ).toEqual({ scope: 'mine', since: Date.parse('2026-11-01T08:00:00Z'), until: Date.parse('2026-11-02T18:30:00Z') })
    expect(parseRunFilter(new URLSearchParams('until=1h'), grant(), now)).toEqual({
      scope: 'mine',
      until: Date.parse('2026-11-08T11:00:00Z'),
    })
    expect(() => parseRunFilter(new URLSearchParams('since=yesterday'), grant(), now)).toThrow('since:')
    expect(() => parseRunFilter(new URLSearchParams('until=soon'), grant(), now)).toThrow('until:')
    expect(() =>
      parseRunFilter(new URLSearchParams('since=2026-11-02T00:00:00Z&until=2026-11-01T00:00:00Z'), grant(), now)
    ).toThrow('until: after since')
  })

  it('keeps the runs of the scope, in their states, of their kind', async () => {
    const { executor } = manual()
    const registry = new RunRegistry({ executor, maxConcurrent: 1 })
    const mine = registry.submit(alice, spec)
    const preview = registry.submit(bob, service('pr-1'))
    const theirs = registry.submit(bob, spec)
    await tick()
    const all = registry.all()
    expect(all.map((run) => run.id)).toEqual([theirs.id, preview.id, mine.id])
    const ids = (runs: { id: string }[]) => runs.map((run) => run.id)
    expect(ids(filterRuns(all, viewer(alice), { scope: 'mine' }))).toEqual([mine.id])
    const opener = viewer(alice, { endpoints: [{ repo: 'github.com/corp/payments', level: 'open' }] })
    expect(ids(filterRuns(all, opener, { scope: 'visible' }))).toEqual([preview.id, mine.id])
    expect(ids(filterRuns(all, opener, { scope: 'visible', kind: 'tasks' }))).toEqual([mine.id])
    expect(ids(filterRuns(all, viewer(carol, { observe: true }), { scope: 'all', states: ['queued'] }))).toEqual([
      theirs.id,
      preview.id,
    ])
    // created since a moment
    const created = Date.parse(mine.createdAt)
    expect(ids(filterRuns(all, viewer(alice), { scope: 'mine', since: created }))).toEqual([mine.id])
    expect(ids(filterRuns(all, viewer(alice), { scope: 'mine', since: created + 1 }))).toEqual([])
    // and until one
    expect(ids(filterRuns(all, viewer(alice), { scope: 'mine', until: created }))).toEqual([mine.id])
    expect(ids(filterRuns(all, viewer(alice), { scope: 'mine', until: created - 1 }))).toEqual([])
  })
})

describe('runActions', () => {
  it('says which buttons work for the caller: stop for who owns or decides, extend for who may open', async () => {
    const executor: RunExecutor = {
      execute: (_run, context) =>
        new Promise<void>((resolve) => {
          setTimeout(() => context.up?.([]), 1)
          context.signal.addEventListener('abort', () => resolve())
        }),
    }
    const registry = new RunRegistry({ executor, up: { maxTtl: 60 * 60 * 1000, perCaller: 2, total: 5 } })
    const preview = registry.submit(carol, service('pr-7'))
    const approval = registry.submit(bob, { ...spec, accounts: ['prod'] }, ['prod'])
    for (let i = 0; i < 200 && registry.peek(preview.id)?.state !== 'up'; i++) {
      await tick()
    }
    const up = registry.peek(preview.id)!
    expect(up.state).toBe('up')
    expect(runActions(viewer(carol), up)).toEqual({ stop: true, extend: true })
    expect(runActions(viewer(alice, { endpoints: [{ repo: 'github.com/corp/*', level: 'open' }] }), up)).toEqual({
      extend: true,
    })
    // who may publish endpoints of the repository may stop its service runs too
    expect(runActions(viewer(alice, { endpoints: [{ repo: 'github.com/corp/*', level: 'publish' }] }), up)).toEqual({
      stop: true,
      extend: true,
    })
    // seeing every run changes nothing
    expect(runActions(viewer(alice, { observe: true }), up)).toBeUndefined()
    expect(runActions(viewer(alice), up)).toBeUndefined()
    const waiting = registry.peek(approval.id)!
    expect(runActions(viewer(carol, { accounts: { prod: 'use' } }), waiting)).toEqual({ stop: true, decide: true })
    // not one's own
    expect(runActions(viewer(bob, { accounts: { prod: 'use' } }), waiting)).toEqual({ stop: true })
    registry.cancel(carol, preview.id)
    for (let i = 0; i < 200 && registry.peek(preview.id)?.state === 'up'; i++) {
      await tick()
    }
    expect(runActions(viewer(carol), registry.peek(preview.id)!)).toBeUndefined()
    await registry.close()
  })

  it('offers to wake a service run that sleeps, to who owns it or may open it', async () => {
    const executor: RunExecutor = {
      execute: (_run, context) =>
        new Promise<void>((resolve) => {
          setTimeout(() => context.up?.([]), 1)
          context.signal.addEventListener('abort', () => resolve())
        }),
    }
    const registry = new RunRegistry({ executor, up: { maxTtl: 60 * 60 * 1000, perCaller: 2, total: 5 } })
    const sleepy = registry.submit(carol, { ...service('pr-8'), up: { ...service('pr-8').up, sleepTtl: 10 } })
    for (let i = 0; i < 400 && registry.peek(sleepy.id)?.state !== 'asleep'; i++) {
      await tick()
    }
    const asleep = registry.peek(sleepy.id)
    if (!asleep) {
      throw new Error(`run ${sleepy.id} is gone`)
    }
    expect(asleep.state).toBe('asleep')
    expect(runActions(viewer(carol), asleep)).toEqual({ stop: true, extend: true, wake: true })
    expect(runActions(viewer(alice, { endpoints: [{ repo: 'github.com/corp/*', level: 'open' }] }), asleep)).toEqual({
      extend: true,
      wake: true,
    })
    expect(runActions(viewer(alice), asleep)).toBeUndefined()
    await registry.close()
  })

  it('narrows a list to one run by its id', () => {
    expect(parseRunFilter(new URLSearchParams('scope=visible&id=run_aaaaaaaaaaaaaaaa'), grant())).toEqual({
      scope: 'visible',
      id: 'run_aaaaaaaaaaaaaaaa',
    })
    expect(() => parseRunFilter(new URLSearchParams('id=../x'), grant())).toThrow('id: the id of a run')
  })

  it('tells what the capacity misses in a few words, and why only to who observes', () => {
    const capacity = {
      backend: 'kubernetes' as const,
      at: '',
      runs: { requested: {} },
      groups: [],
      problems: ['the nodes: not shown, the server may not list nodes (optional, see the backend docs)'],
      unknown: { total: 'may not list nodes', used: 'no metrics API' },
    }
    expect(visibleCapacity(capacity, viewer(alice, { observe: true }))).toMatchObject({
      problems: capacity.problems,
      unknown: capacity.unknown,
    })
    expect(visibleCapacity(capacity, viewer(alice))).toMatchObject({
      problems: ['some of it could not be read'],
      unknown: { total: 'not readable', used: 'not readable' },
    })
    expect(visibleCapacity({ ...capacity, problems: [], unknown: undefined }, viewer(alice)).unknown).toBeUndefined()
  })

  it('shows what runs of others take of the capacity, not what they are, but to who observes', () => {
    const use = (owner: { iss: string; sub: string }) => ({
      kind: 'run' as const,
      run: `run_of_${owner.sub}`,
      tasks: ['build'],
      repo: 'github.com/corp/payments',
      owner,
      pods: 1,
      requested: { cpu: 1, memory: 1024 },
      used: { cpu: 0.5, memory: 512 },
    })
    const capacity = {
      backend: 'kubernetes' as const,
      at: '',
      runs: { requested: {} },
      groups: [],
      uses: [use(alice), use(bob), { kind: 'other' as const, pods: 1, requested: { cpu: 1 } }],
      problems: [],
    }
    expect(visibleCapacity(capacity, viewer(alice, { observe: true })).uses).toEqual(capacity.uses)
    expect(visibleCapacity(capacity, viewer(alice)).uses).toEqual([
      use(alice),
      { kind: 'run', pods: 1, requested: { cpu: 1, memory: 1024 }, used: { cpu: 0.5, memory: 512 } },
      capacity.uses[2],
    ])
  })
})
