import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EndpointTarget, QuotaError, Run, RunError, RunExecutor, RunRegistry, ServiceRunSpec } from './runs'
import { FileRunStore } from './run-store'

const alice = { iss: 'https://idp.corp', sub: 'alice' }
const bob = { iss: 'https://idp.corp', sub: 'bob' }
const HOUR = 60 * 60 * 1000

function up(name: string, ttl = HOUR): ServiceRunSpec {
  return {
    services: ['web'],
    ttl,
    name,
    endpoints: [{ service: 'web', port: 80, host: `${name}-80-abcdef`, url: `https://${name}-80-abcdef.run.test/` }],
  }
}

function spec(name = 'feature', ttl = HOUR, sleepTtl?: number) {
  return {
    definition: 'sha256:' + 'a'.repeat(64),
    tasks: [],
    accounts: [] as string[],
    source: { type: 'ref' as const, repo: 'github.com/corp/shop', ref: name, commit: 'c'.repeat(40) },
    options: {},
    up: { ...up(name, ttl), ...(sleepTtl ? { sleepTtl } : {}) },
  }
}

const target = (port: number): EndpointTarget => ({
  service: 'web',
  port: 80,
  address: { host: '127.0.0.1', port },
})

// An executor whose services the test brings up by hand; each stays until its run's signal aborts.
function services() {
  const started: { up: (targets: EndpointTarget[]) => void; signal: AbortSignal; end: () => void }[] = []
  const executor: RunExecutor = {
    // like the cluster's: a run of tasks holds the caller's claims, a service run a namespace of its own
    exclusive: (run) => (run.up ? undefined : 'claims'),
    execute: (_run, context) =>
      new Promise<void>((resolve) => {
        started.push({ up: (targets) => context.up?.(targets), signal: context.signal, end: resolve })
        context.signal.addEventListener('abort', () => resolve())
      }),
  }
  return { executor, started }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

// An executor as `services`, that also says what it kept when a run stopped, and hears what to
// remove: `hold` keeps a run that stops from ending until the test lets it.
function keeping(hold = false, beside = false) {
  const started: {
    run: Run
    up: (targets: EndpointTarget[]) => void
    signal: AbortSignal
    end: () => void
    fail: (e: Error) => void
    kept?: string
  }[] = []
  const forgotten: string[] = []
  const restored: string[][] = []
  const executor: RunExecutor = {
    execute: (run, context) =>
      new Promise<void>((resolve, reject) => {
        const one: (typeof started)[number] = {
          run,
          up: (targets) => context.up?.(targets),
          signal: context.signal,
          end: resolve,
          fail: reject,
        }
        started.push(one)
        context.signal.addEventListener('abort', () => {
          // what a backend asks as it releases the services
          one.kept = context.keep?.() ?? 'nothing'
          if (!hold) {
            resolve()
          }
        })
      }),
    forget: async (run) => {
      forgotten.push(run.id)
    },
    restored: (runs) => restored.push(runs.map((run) => run.id)),
    ...(beside ? { movesBeside: () => true } : {}),
  }
  return { executor, started, forgotten, restored }
}

describe('RunRegistry service runs', () => {
  it('is up once its services are ready, until its ttl ends', async () => {
    const { executor, started } = services()
    const registry = new RunRegistry({ executor, up: { maxTtl: HOUR, perCaller: 3, total: 10 } })
    const run = registry.submit(alice, spec('feature', 40))
    await tick()
    expect(registry.get(alice, run.id)?.state).toBe('running')
    // no address before the services are up
    expect(registry.endpoint('feature-80-abcdef')).toMatchObject({ run: { state: 'running' } })
    expect(registry.endpoint('feature-80-abcdef')?.target).toBeUndefined()

    started[0].up([target(4100)])
    const upRun = registry.get(alice, run.id)
    expect(upRun?.state).toBe('up')
    expect(Date.parse(upRun?.expiresAt ?? '') - Date.parse(upRun?.upAt ?? '')).toBe(40)
    expect(registry.endpoint('feature-80-abcdef')?.target).toEqual(target(4100))
    expect(registry.endpoint('other-80-abcdef')).toBeUndefined()

    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(started[0].signal.aborted).toBe(true)
    expect(registry.get(alice, run.id)).toMatchObject({ state: 'succeeded', stoppedBy: 'ttl' })
    expect(registry.endpoint('feature-80-abcdef')?.target).toBeUndefined()
  })

  it('gives its place to the next run once up, and does not hold the caller back while it starts', async () => {
    const { executor, started } = services()
    const registry = new RunRegistry({ executor, maxConcurrent: 1 })
    const first = registry.submit(alice, spec('one'))
    const second = registry.submit(alice, spec('two'))
    await tick()
    // maxConcurrent 1: the second waits for the place of the first
    expect(registry.get(alice, second.id)?.state).toBe('queued')
    started[0].up([target(4100)])
    await tick()
    expect(registry.get(alice, first.id)?.state).toBe('up')
    expect(registry.get(alice, second.id)?.state).toBe('running')
  })

  it('starts next to a run of tasks of the same caller that holds what the next run of tasks waits for', async () => {
    const { executor, started } = services()
    const registry = new RunRegistry({ executor })
    registry.submit(alice, { ...spec(), up: undefined, tasks: ['build'] })
    const tasks = registry.submit(alice, { ...spec(), up: undefined, tasks: ['build'] })
    const service = registry.submit(alice, spec())
    await tick()
    expect(started).toHaveLength(2)
    expect(registry.get(alice, tasks.id)?.state).toBe('queued')
    expect(registry.get(alice, service.id)?.state).toBe('running')
  })

  it('replaces an older run of the caller with the same name once the new one is up', async () => {
    const { executor, started } = services()
    const registry = new RunRegistry({ executor })
    const old = registry.submit(alice, spec())
    await tick()
    started[0].up([target(4100)])
    // the hosts of a caller's run carry their owner: bob's of the same name are others
    const bobs = spec()
    bobs.up.endpoints = [{ ...bobs.up.endpoints[0], host: 'feature-80-123456' }]
    const theirs = registry.submit(bob, bobs)
    const next = registry.submit(alice, spec())
    await tick()
    started[1].up([target(4200)])
    // until the new one is up, the old one answers
    expect(registry.get(alice, next.id)?.state).toBe('running')
    expect(registry.endpoint('feature-80-abcdef')?.target).toEqual(target(4100))
    started[2].up([target(4300)])
    expect(registry.endpoint('feature-80-abcdef')?.target).toEqual(target(4300))
    await tick()
    expect(registry.get(alice, old.id)).toMatchObject({ state: 'succeeded', stoppedBy: 'replaced' })
    expect(registry.get(alice, next.id)?.state).toBe('up')
    // somebody else's run of that name is theirs
    expect(registry.get(bob, theirs.id)?.state).toBe('up')
  })

  it('says who stopped it', async () => {
    const { executor, started } = services()
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, spec())
    await tick()
    started[0].up([target(4100)])
    registry.cancel(alice, run.id)
    await tick()
    expect(registry.get(alice, run.id)).toMatchObject({ state: 'succeeded', stoppedBy: alice })
  })

  it('is stopped by somebody besides its owner who may stop it, and by nobody else', async () => {
    const { executor, started } = services()
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, spec())
    await tick()
    started[0].up([target(4100)])
    expect(registry.cancel(bob, run.id)).toBeUndefined()
    expect(registry.cancel(bob, run.id, undefined, () => false)).toBeUndefined()
    expect(registry.get(alice, run.id)?.state).toBe('up')
    expect(registry.cancel(bob, run.id, undefined, () => true)?.id).toBe(run.id)
    await tick()
    expect(registry.get(alice, run.id)).toMatchObject({ state: 'succeeded', stoppedBy: bob })
  })

  it('fails when the services stop on their own', async () => {
    const { executor, started } = services()
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, spec())
    await tick()
    started[0].up([target(4100)])
    started[0].end()
    await tick()
    expect(registry.get(alice, run.id)).toMatchObject({ state: 'failed', error: 'the services stopped on their own' })
  })

  it('is extended by its owner and whoever may open its endpoints, up to maxTtl', async () => {
    const now = Date.parse('2026-10-25T10:00:00Z')
    const { executor, started } = services()
    const registry = new RunRegistry({ executor, now: () => now, up: { maxTtl: 4 * HOUR, perCaller: 3, total: 10 } })
    const run = registry.submit(alice, spec())
    await tick()
    expect(registry.extend(alice, run.id, HOUR)).toEqual({ status: 'not-up', state: 'running' })
    started[0].up([target(4100)])
    expect(registry.extend(bob, run.id, HOUR)).toEqual({ status: 'not-found' })
    expect(registry.extend(bob, run.id, HOUR, () => false)).toEqual({ status: 'not-found' })
    const extended = registry.extend(bob, run.id, 100 * HOUR, () => true)
    expect(extended).toMatchObject({ status: 'ok', run: { expiresAt: '2026-10-25T14:00:00.000Z' } })
    const events = registry.watch(alice, run.id, 0, () => undefined)?.events ?? []
    expect(events.find((event) => event.type === 'extended')).toMatchObject({ by: bob })
  })

  it('counts the service runs of a caller and of the server', async () => {
    const { executor } = services()
    const registry = new RunRegistry({ executor, up: { maxTtl: HOUR, perCaller: 2, total: 3 } })
    registry.submit(alice, spec('a'))
    registry.submit(alice, spec('b'))
    expect(() => registry.submit(alice, spec('c'))).toThrow(QuotaError)
    const bobs = (name: string) => {
      const request = spec(name)
      request.up.endpoints = [{ ...request.up.endpoints[0], host: `${name}-80-123456` }]
      return request
    }
    registry.submit(bob, bobs('a'))
    let error: unknown
    try {
      registry.submit(bob, bobs('b'))
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(RunError)
    expect(error).not.toBeInstanceOf(QuotaError)
    // a run of tasks is not one of them
    expect(() => registry.submit(bob, { ...spec(), up: undefined, tasks: ['build'] })).not.toThrow()
  })

  it('takes no other place for a run that replaces one of the same name', async () => {
    const { executor, started } = services()
    const registry = new RunRegistry({ executor, up: { maxTtl: HOUR, perCaller: 2, total: 3 } })
    const first = registry.submit(alice, spec('a'))
    registry.submit(alice, spec('b'))
    await tick()
    started.forEach((service, index) => service.up([target(4100 + index)]))
    // a new commit of a: it replaces the first once up, the caller has the same two
    const second = registry.submit(alice, spec('a'))
    expect(() => registry.submit(alice, spec('c'))).toThrow(QuotaError)
    await tick()
    started[2].up([target(4300)])
    await vi.waitFor(() =>
      expect(registry.get(alice, first.id)).toMatchObject({ state: 'succeeded', stoppedBy: 'replaced' })
    )
    expect(registry.get(alice, second.id)?.state).toBe('up')
    // the server counts one place per caller and name too
    const bobs = spec('a')
    bobs.up.endpoints = [{ ...bobs.up.endpoints[0], host: 'a-80-123456' }]
    registry.submit(bob, bobs)
    expect(() => registry.submit(bob, bobs)).not.toThrow()
    const other = spec('b')
    other.up.endpoints = [{ ...other.up.endpoints[0], host: 'b-80-123456' }]
    expect(() => registry.submit(bob, other)).toThrow(/the server has 3 service runs/)
    await registry.close()
  })

  it('gives a place back while it sleeps, and wakes only when there is one', async () => {
    const { executor, started } = services()
    const registry = new RunRegistry({ executor, up: { maxTtl: HOUR, perCaller: 1, total: 10 } })
    const sleepy = registry.submit(alice, spec('sleepy', HOUR, 30))
    await tick()
    started[0].up([target(4100)])
    await vi.waitFor(() => expect(registry.get(alice, sleepy.id)?.state).toBe('asleep'))
    // asleep, it holds no place
    const other = registry.submit(alice, spec('other'))
    await tick()
    started[1].up([target(4200)])
    expect(() => registry.submit(alice, spec('third'))).toThrow(/you have 1 service runs starting or up/)
    // a wake needs a place: it sleeps on and says why
    expect(registry.visit(sleepy.id)).toMatch(/its owner has as many service runs starting or up as they may/)
    expect(registry.get(alice, sleepy.id)?.state).toBe('asleep')
    expect(started).toHaveLength(2)
    // once the other stops, the next request wakes it
    registry.cancel(alice, other.id)
    await vi.waitFor(() => expect(registry.get(alice, other.id)?.state).toBe('succeeded'))
    expect(registry.visit(sleepy.id)).toBeUndefined()
    await vi.waitFor(() => expect(started).toHaveLength(3))
    expect(registry.get(alice, sleepy.id)?.state).toBe('running')
    await registry.close()
  })

  it('wakes a run while a run of its name starts, and not over the limit of the server', async () => {
    const { executor, started } = services()
    const registry = new RunRegistry({ executor, up: { maxTtl: HOUR, perCaller: 1, total: 1 } })
    const sleepy = registry.submit(alice, spec('sleepy', HOUR, 30))
    await tick()
    started[0].up([target(4100)])
    await vi.waitFor(() => expect(registry.get(alice, sleepy.id)?.state).toBe('asleep'))
    // bob takes the one place of the server
    const bobs = spec('bobs')
    bobs.up.endpoints = [{ ...bobs.up.endpoints[0], host: 'bobs-80-123456' }]
    const other = registry.submit(bob, bobs)
    expect(registry.visit(sleepy.id)).toMatch(/the server has as many service runs starting or up as it may/)
    expect(registry.get(alice, sleepy.id)?.state).toBe('asleep')
    registry.cancel(bob, other.id)
    await vi.waitFor(() => expect(registry.get(bob, other.id)?.state).toBe('cancelled'))
    // a new commit of sleepy takes the place, the old one may still wake beside it
    registry.submit(alice, spec('sleepy', HOUR, 30))
    expect(registry.visit(sleepy.id)).toBeUndefined()
    expect(registry.get(alice, sleepy.id)?.state).not.toBe('asleep')
    await registry.close()
  })

  it('refuses a new run while the caller has as many runs asleep as they may', async () => {
    const { executor, started } = services()
    const registry = new RunRegistry({ executor, up: { maxTtl: HOUR, perCaller: 2, total: 10, asleep: 2 } })
    // one that stays up, and two that sleep
    registry.submit(alice, spec('x'))
    await vi.waitFor(() => expect(started).toHaveLength(1))
    started[0].up([target(4000)])
    for (const name of ['a', 'b']) {
      const count = started.length
      const run = registry.submit(alice, spec(name, HOUR, 30))
      await vi.waitFor(() => expect(started).toHaveLength(count + 1))
      started[count].up([target(4100)])
      await vi.waitFor(() => expect(registry.get(alice, run.id)?.state).toBe('asleep'))
    }
    expect(() => registry.submit(alice, spec('c'))).toThrow(/you have 2 service runs asleep/)
    // a new commit of one that sleeps, or of one that is up, replaces it: it is not one more
    expect(() => registry.submit(alice, spec('a'))).not.toThrow()
    expect(() => registry.submit(alice, spec('x'))).not.toThrow()
    await registry.close()
  })

  it('ends an older run of a name that gets up after a newer one, once it was approved', async () => {
    const { executor, started } = services()
    const registry = new RunRegistry({ executor, up: { maxTtl: HOUR, perCaller: 1, total: 10 } })
    const older = registry.submit(alice, spec('a'), ['prod'])
    const newer = registry.submit(alice, spec('a'))
    await tick()
    started[0].up([target(4100)])
    expect(registry.get(alice, newer.id)?.state).toBe('up')
    expect(registry.decide(bob, older.id, 'approved', () => true)).toMatchObject({ status: 'ok' })
    await tick()
    started[1].up([target(4200)])
    await vi.waitFor(() =>
      expect(registry.get(alice, older.id)).toMatchObject({ state: 'succeeded', stoppedBy: 'replaced' })
    )
    expect(started[1].signal.aborted).toBe(true)
    expect(registry.get(alice, newer.id)?.state).toBe('up')
    expect(registry.endpoint('a-80-abcdef')?.run.id).toBe(newer.id)
    await registry.close()
  })

  it('ends a run that was asleep when its ttl ran out while the server was down, and frees its place', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hammerkit-runs-up-'))
    try {
      let now = Date.parse('2026-11-07T10:00:00Z')
      const { executor, started } = services()
      const registry = new RunRegistry({ executor, now: () => now, store: new FileRunStore(directory) })
      const run = registry.submit(alice, spec('sleepy', HOUR, 60_000))
      await tick()
      started[0].up([target(4100)])
      await registry.close()
      expect(registry.get(alice, run.id)?.state).toBe('asleep')
      // the server is down past the run's end
      now += 2 * HOUR
      const restarted = new RunRegistry({
        executor: services().executor,
        now: () => now,
        store: new FileRunStore(directory),
        up: { maxTtl: HOUR, perCaller: 1, total: 10 },
      })
      await restarted.restore()
      expect(restarted.get(alice, run.id)).toMatchObject({ state: 'succeeded', stoppedBy: 'ttl' })
      expect(() => restarted.submit(alice, spec('other'))).not.toThrow()
      await restarted.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails a service run that was up when the server stopped', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hammerkit-runs-up-'))
    try {
      const { executor, started } = services()
      const store = new FileRunStore(directory)
      const registry = new RunRegistry({ executor, store })
      const run = registry.submit(alice, spec())
      await vi.waitFor(() => expect(started).toHaveLength(1))
      started[0].up([target(4100)])
      expect(registry.get(alice, run.id)?.state).toBe('up')
      // the record says it is up when the server stops
      await vi.waitFor(
        async () => {
          const { records } = await new FileRunStore(directory).load()
          expect(records.find((record) => record.run.id === run.id)?.run.state).toBe('up')
        },
        { timeout: 10_000 }
      )
      const restarted = new RunRegistry({ executor: services().executor, store: new FileRunStore(directory) })
      await restarted.restore()
      expect(restarted.get(alice, run.id)).toMatchObject({
        state: 'failed',
        error: 'the server stopped while the services were up, start them again',
      })
      await registry.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails a service run that was up when the server shut down', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hammerkit-runs-up-'))
    try {
      const { executor, started } = services()
      const registry = new RunRegistry({ executor, store: new FileRunStore(directory) })
      const run = registry.submit(alice, spec())
      await vi.waitFor(() => expect(started).toHaveLength(1))
      started[0].up([target(4100)])
      await registry.close()
      const failed = { state: 'failed', error: 'the server stopped while the services were up, start them again' }
      expect(registry.get(alice, run.id)).toMatchObject(failed)
      expect(registry.get(alice, run.id)?.stoppedBy).toBeUndefined()
      const restarted = new RunRegistry({ executor: services().executor, store: new FileRunStore(directory) })
      await restarted.restore()
      expect(restarted.get(alice, run.id)).toMatchObject(failed)
      await restarted.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('sleeps without a request for its sleepTtl, and wakes on the next, as the same run', async () => {
    const { executor, started } = services()
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, spec('feature', HOUR, 400))
    await tick()
    started[0].up([target(4100)])
    const expiresAt = registry.get(alice, run.id)?.expiresAt
    // a request keeps it up
    await new Promise((resolve) => setTimeout(resolve, 250))
    registry.visit(run.id)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(registry.get(alice, run.id)?.state).toBe('up')
    await vi.waitFor(() => expect(registry.get(alice, run.id)?.state).toBe('asleep'), { timeout: 5000 })
    expect(started[0].signal.aborted).toBe(true)
    expect(registry.get(alice, run.id)?.state).toBe('asleep')
    expect(registry.endpoint('feature-80-abcdef')?.target).toBeUndefined()

    expect(registry.visit(run.id)).toBeUndefined()
    await tick()
    expect(registry.get(alice, run.id)).toMatchObject({ state: 'running', wakes: 1 })
    started[1].up([target(4200)])
    // the ttl counts from the first time it was up
    expect(registry.get(alice, run.id)).toMatchObject({ state: 'up', expiresAt })
    expect(registry.endpoint('feature-80-abcdef')?.target).toEqual(target(4200))
  })

  it('wakes when its owner or who may open it asks, as a request would, and says why when it can not', async () => {
    const { executor, started } = services()
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, spec('feature', HOUR, 10))
    await tick()
    // starting: nothing to wake
    expect(registry.wake(alice, run.id)).toEqual({ status: 'not-asleep', state: 'running' })
    started[0].up([target(4100)])
    await vi.waitFor(() => expect(registry.get(alice, run.id)?.state).toBe('asleep'), { timeout: 5000 })
    // somebody who may not open it does not find it
    expect(registry.wake(bob, run.id)).toEqual({ status: 'not-found' })
    expect(registry.wake(bob, run.id, () => false)).toEqual({ status: 'not-found' })
    expect(registry.wake(alice, 'run_nope')).toEqual({ status: 'not-found' })
    // whose owner may no longer run it: it sleeps on, as asked
    expect(
      registry.wake(
        bob,
        run.id,
        () => true,
        () => 'not now'
      )
    ).toMatchObject({
      status: 'refused',
      reason: 'not now',
    })
    expect(registry.get(alice, run.id)?.state).toBe('failed')
    const again = registry.submit(alice, spec('second', HOUR, 10))
    await tick()
    started[1].up([target(4200)])
    await vi.waitFor(() => expect(registry.get(alice, again.id)?.state).toBe('asleep'), { timeout: 5000 })
    const woken = registry.wake(bob, again.id, () => true)
    // with a place free, it starts at once
    expect(woken).toMatchObject({ status: 'ok', run: { id: again.id, state: 'running', wakes: 1 } })
    await tick()
    expect(registry.get(alice, again.id)).toMatchObject({ state: 'running', wakes: 1 })
    expect(started).toHaveLength(3)
  })

  it('ends instead of waking when its owner may no longer run it, and keeps their rights for the check', async () => {
    const { executor, started } = services()
    const registry = new RunRegistry({ executor })
    const owner = { ...alice, groups: ['dev'], claims: { repository: 'corp/shop' } }
    const run = registry.submit(owner, spec('feature', HOUR, 10))
    const plain = registry.submit(owner, spec('plain'))
    await tick()
    started[0].up([target(4100)])
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(registry.get(alice, run.id)?.state).toBe('asleep')
    const seen: unknown[] = []
    const refused = registry.visit(run.id, (asleep) => {
      seen.push(asleep.owner)
      return 'its owner alice may no longer run it'
    })
    expect(refused).toBe('its owner alice may no longer run it')
    expect(seen).toEqual([owner])
    expect(registry.get(alice, run.id)).toMatchObject({ state: 'failed', error: refused })
    expect(started).toHaveLength(2)
    // a run that does not sleep keeps no more of its owner than who they are
    expect(registry.get(alice, plain.id)?.owner).toEqual(alice)
  })

  it('ends at its ttl, asleep or not, and when it is stopped or replaced while asleep', async () => {
    const { executor, started } = services()
    const registry = new RunRegistry({ executor })
    const short = registry.submit(alice, spec('short', 80, 10))
    const stopped = registry.submit(alice, spec('stopped', HOUR, 10))
    const replaced = registry.submit(alice, spec('feature', HOUR, 10))
    await tick()
    started.forEach((one, index) => one.up([target(4100 + index)]))
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect([short, stopped, replaced].map((run) => registry.get(alice, run.id)?.state)).toEqual([
      'asleep',
      'asleep',
      'asleep',
    ])
    registry.cancel(alice, stopped.id)
    expect(registry.get(alice, stopped.id)).toMatchObject({ state: 'succeeded', stoppedBy: alice })
    registry.submit(alice, spec('feature'))
    await tick()
    started[3].up([target(4300)])
    expect(registry.get(alice, replaced.id)).toMatchObject({ state: 'succeeded', stoppedBy: 'replaced' })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(registry.get(alice, short.id)).toMatchObject({ state: 'succeeded', stoppedBy: 'ttl' })
    expect(registry.visit(short.id)).toBeUndefined()
    expect(registry.get(alice, short.id)?.state).toBe('succeeded')
  })

  it('is asleep after the server stopped, when it may sleep', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hammerkit-runs-up-'))
    try {
      const { executor, started } = services()
      const registry = new RunRegistry({ executor, store: new FileRunStore(directory) })
      const sleepy = registry.submit(alice, spec('sleepy', HOUR, HOUR))
      const awake = registry.submit(alice, spec('awake'))
      await tick()
      started[0].up([target(4100)])
      started[1].up([target(4200)])
      await registry.close()
      const next = services()
      const restarted = new RunRegistry({ executor: next.executor, store: new FileRunStore(directory) })
      await restarted.restore()
      expect(restarted.get(alice, sleepy.id)?.state).toBe('asleep')
      expect(restarted.get(alice, awake.id)?.state).not.toBe('asleep')
      restarted.visit(sleepy.id)
      await tick()
      expect(next.started).toHaveLength(1)
      await restarted.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('is asleep after the server went away while it was up, when it may sleep', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hammerkit-runs-up-'))
    try {
      const { executor, started } = services()
      const registry = new RunRegistry({ executor, store: new FileRunStore(directory) })
      const run = registry.submit(alice, spec('sleepy', HOUR, HOUR))
      await vi.waitFor(() => expect(started).toHaveLength(1))
      started[0].up([target(4100)])
      // the record says it is up, as it does when the server is killed
      await vi.waitFor(
        async () => {
          const { records } = await new FileRunStore(directory).load()
          expect(records.find((record) => record.run.id === run.id)?.run.state).toBe('up')
        },
        { timeout: 10_000 }
      )
      const restarted = new RunRegistry({ executor: services().executor, store: new FileRunStore(directory) })
      await restarted.restore()
      expect(restarted.get(alice, run.id)?.state).toBe('asleep')
      await restarted.close()
      await registry.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps the volumes of a run that sleeps for its wake, and removes them when it ends asleep', async () => {
    const { executor, started, forgotten } = keeping()
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, spec('feature', HOUR, 20))
    await tick()
    started[0].up([target(4100)])
    await vi.waitFor(() => expect(registry.get(alice, run.id)?.state).toBe('asleep'))
    expect(started[0].kept).toBe('volumes')
    expect(registry.get(alice, run.id)?.volumesKept).toBe(true)
    // the wake mounts them: they stay the run's while it is up
    registry.visit(run.id)
    await tick()
    expect(registry.get(alice, run.id)).toMatchObject({ state: 'running', volumesKept: true })
    started[1].up([target(4200)])
    await vi.waitFor(() => expect(registry.get(alice, run.id)?.state).toBe('asleep'))
    expect(forgotten).toEqual([])
    registry.cancel(alice, run.id)
    expect(registry.get(alice, run.id)).toMatchObject({ state: 'succeeded', stoppedBy: alice })
    expect(registry.get(alice, run.id)?.volumesKept).toBeUndefined()
    await vi.waitFor(() => expect(forgotten).toEqual([run.id]))
  })

  it('keeps nothing of a run that ends while up, or on a server that keeps no volumes', async () => {
    const one = keeping()
    const registry = new RunRegistry({ executor: one.executor })
    const plain = registry.submit(alice, spec('plain'))
    await tick()
    one.started[0].up([target(4100)])
    registry.cancel(alice, plain.id)
    await vi.waitFor(() => expect(registry.get(alice, plain.id)?.state).toBe('succeeded'))
    expect(one.started[0].kept).toBe('nothing')

    const other = keeping()
    const none = new RunRegistry({
      executor: other.executor,
      up: { maxTtl: HOUR, perCaller: 3, total: 10, keepVolumes: false },
    })
    const run = none.submit(alice, spec('feature', HOUR, 20))
    await tick()
    other.started[0].up([target(4100)])
    await vi.waitFor(() => expect(none.get(alice, run.id)?.state).toBe('asleep'))
    expect(other.started[0].kept).toBe('nothing')
    expect(none.get(alice, run.id)?.volumesKept).toBeUndefined()
    none.cancel(alice, run.id)
    await tick()
    expect(other.forgotten).toEqual([])
  })

  it('removes what a run kept as it fell asleep when it is stopped before it is asleep', async () => {
    const { executor, started, forgotten } = keeping(true)
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, spec('feature', HOUR, 20))
    await tick()
    started[0].up([target(4100)])
    await vi.waitFor(() => expect(started[0].kept).toBe('volumes'))
    // the executor still releases the services when the stop comes
    registry.cancel(alice, run.id)
    started[0].end()
    await vi.waitFor(() => expect(registry.get(alice, run.id)?.state).toBe('succeeded'))
    await vi.waitFor(() => expect(forgotten).toEqual([run.id]))
  })

  it('tells the executor which runs sleep with their volumes after the server started again', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hammerkit-runs-up-'))
    try {
      const first = keeping()
      const registry = new RunRegistry({ executor: first.executor, store: new FileRunStore(directory) })
      const sleepy = registry.submit(alice, spec('sleepy', HOUR, HOUR))
      const awake = registry.submit(alice, spec('awake'))
      await tick()
      first.started.forEach((one, index) => one.up([target(4100 + index)]))
      await registry.close()
      expect(first.started.map((one) => one.kept)).toEqual(['volumes', 'nothing'])

      const second = keeping()
      const restarted = new RunRegistry({ executor: second.executor, store: new FileRunStore(directory) })
      await restarted.restore()
      expect(restarted.get(alice, sleepy.id)).toMatchObject({ state: 'asleep', volumesKept: true })
      expect(restarted.get(alice, awake.id)?.volumesKept).toBeUndefined()
      expect(second.restored).toEqual([[sleepy.id]])
      await restarted.close()

      // a server that keeps none any more removes them all
      const third = keeping()
      const without = new RunRegistry({
        executor: third.executor,
        store: new FileRunStore(directory),
        up: { maxTtl: HOUR, perCaller: 3, total: 10, keepVolumes: false },
      })
      await without.restore()
      expect(without.get(alice, sleepy.id)?.state).toBe('asleep')
      expect(without.get(alice, sleepy.id)?.volumesKept).toBeUndefined()
      expect(third.restored).toEqual([[]])
      await without.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('ends a run whose time ran out while the server was down, and removes what it kept', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hammerkit-runs-up-'))
    try {
      let now = Date.parse('2026-11-07T10:00:00Z')
      const first = keeping()
      const registry = new RunRegistry({ executor: first.executor, store: new FileRunStore(directory), now: () => now })
      const run = registry.submit(alice, spec('sleepy', HOUR, HOUR))
      await tick()
      first.started[0].up([target(4100)])
      await registry.close()
      now += 2 * HOUR
      const second = keeping()
      const restarted = new RunRegistry({
        executor: second.executor,
        store: new FileRunStore(directory),
        now: () => now,
      })
      await restarted.restore()
      await vi.waitFor(() =>
        expect(restarted.get(alice, run.id)).toMatchObject({ state: 'succeeded', stoppedBy: 'ttl' })
      )
      await vi.waitFor(() => expect(second.forgotten).toEqual([run.id]))
      await restarted.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  describe('a move to another commit', () => {
    const at = (commit: string) => ({
      source: { type: 'ref' as const, repo: 'github.com/corp/shop', ref: 'feature', commit: commit.repeat(40) },
    })

    it('brings the services up beside the ones that answer, which they replace once ready', async () => {
      const { executor, started } = keeping(false, true)
      const registry = new RunRegistry({ executor })
      const run = registry.submit(alice, spec())
      await tick()
      started[0].up([target(4100)])
      const moving = registry.move(alice, run.id, at('d'))
      expect(moving).toMatchObject({ id: run.id, state: 'up', moving: { commit: 'd'.repeat(40) } })
      await tick()
      expect(started).toHaveLength(2)
      expect(started[1].run).toMatchObject({ id: run.id, source: { commit: 'd'.repeat(40) } })
      // until the new ones are up, the old ones answer
      expect(registry.endpoint('feature-80-abcdef')?.target).toEqual(target(4100))
      expect(started[0].signal.aborted).toBe(false)
      // while it executes, the move counts against the caller's running limit
      expect(registry.usage(alice).running).toEqual([run.id])

      started[1].up([target(4200)])
      expect(registry.usage(alice).running).toEqual([])
      expect(registry.endpoint('feature-80-abcdef')?.target).toEqual(target(4200))
      const moved = registry.get(alice, run.id)
      expect(moved).toMatchObject({ state: 'up', source: { commit: 'd'.repeat(40) } })
      expect(moved?.moving).toBeUndefined()
      expect(moved?.moves).toEqual([{ commit: 'd'.repeat(40), ref: 'feature', at: expect.any(String) }])
      // the first execution leaves its services to the move
      await tick()
      expect(started[0]).toMatchObject({ kept: 'everything' })
      expect(started[0].signal.aborted).toBe(true)
      expect(registry.get(alice, run.id)?.state).toBe('up')

      // the run's end is the move's to see to now
      registry.cancel(alice, run.id)
      await vi.waitFor(() =>
        expect(registry.get(alice, run.id)).toMatchObject({ state: 'succeeded', stoppedBy: alice })
      )
      expect(started[1].kept).toBe('nothing')
    })

    it('ends when it is stopped after it woke on a restarted server and moved', async () => {
      const directory = mkdtempSync(join(tmpdir(), 'hammerkit-runs-up-'))
      try {
        const first = keeping(false, true)
        const registry = new RunRegistry({ executor: first.executor, store: new FileRunStore(directory) })
        const run = registry.submit(alice, spec('feature', HOUR, 200))
        await tick()
        first.started[0].up([target(4100)])
        await vi.waitFor(() => expect(registry.get(alice, run.id)?.state).toBe('asleep'), { timeout: 5000 })
        await registry.close()

        const { executor, started } = keeping(false, true)
        const restarted = new RunRegistry({ executor, store: new FileRunStore(directory) })
        await restarted.restore()
        restarted.visit(run.id)
        await tick()
        started[0].up([target(4200)])
        expect(restarted.get(alice, run.id)?.state).toBe('up')
        // a move that does not get there, then one that does
        restarted.move(alice, run.id, at('d'))
        await tick()
        started[1].fail(new Error('api failed'))
        await vi.waitFor(() => expect(restarted.get(alice, run.id)?.moving).toBeUndefined())
        restarted.move(alice, run.id, at('e'))
        await tick()
        started[2].up([target(4300)])
        await tick()
        expect(restarted.get(alice, run.id)).toMatchObject({ state: 'up', source: { commit: 'e'.repeat(40) } })

        restarted.cancel(alice, run.id)
        await vi.waitFor(() => expect(restarted.get(alice, run.id)).toMatchObject({ state: 'succeeded' }))
        await restarted.close()
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })

    it('stays where it was when the move does not get there', async () => {
      const { executor, started } = keeping(false, true)
      const registry = new RunRegistry({ executor })
      const run = registry.submit(alice, spec())
      await tick()
      started[0].up([target(4100)])
      registry.move(alice, run.id, at('d'))
      await tick()
      started[1].fail(new Error('build failed'))
      await vi.waitFor(() => expect(registry.get(alice, run.id)?.moving).toBeUndefined())
      const after = registry.get(alice, run.id)
      expect(after).toMatchObject({ state: 'up', source: { commit: 'c'.repeat(40) } })
      expect(after?.moves).toEqual([
        { commit: 'd'.repeat(40), ref: 'feature', at: expect.any(String), error: 'build failed' },
      ])
      expect(registry.endpoint('feature-80-abcdef')?.target).toEqual(target(4100))
      expect(started[0].signal.aborted).toBe(false)
      expect(started[1].kept).toBeUndefined()
    })

    it('stops a move that executes for a later one', async () => {
      const { executor, started } = keeping(false, true)
      const registry = new RunRegistry({ executor })
      const run = registry.submit(alice, spec())
      await tick()
      started[0].up([target(4100)])
      registry.move(alice, run.id, at('d'))
      await tick()
      registry.move(alice, run.id, at('e'))
      await vi.waitFor(() => expect(started).toHaveLength(3))
      expect(started[1].signal.aborted).toBe(true)
      expect(started[1].kept).toBe('everything')
      expect(started[2].run.source).toMatchObject({ commit: 'e'.repeat(40) })
      started[2].up([target(4300)])
      expect(registry.get(alice, run.id)?.moves?.map((move) => [move.commit[0], move.error])).toEqual([
        ['d', 'the move was stopped'],
        ['e', undefined],
      ])
    })

    it('moves a run that sleeps, which wakes at the new commit, and one that starts once it is up', async () => {
      const { executor, started } = keeping(false, true)
      const registry = new RunRegistry({ executor })
      const sleepy = registry.submit(alice, spec('sleepy', HOUR, 20))
      await tick()
      started[0].up([target(4100)])
      await vi.waitFor(() => expect(registry.get(alice, sleepy.id)?.state).toBe('asleep'))
      expect(registry.move(alice, sleepy.id, at('d'))).toMatchObject({
        state: 'asleep',
        source: { commit: 'd'.repeat(40) },
      })
      expect(started).toHaveLength(1)
      registry.visit(sleepy.id)
      await tick()
      expect(started[1].run.source).toMatchObject({ commit: 'd'.repeat(40) })

      const starting = registry.submit(alice, spec('starting'))
      await tick()
      registry.move(alice, starting.id, at('e'))
      expect(started).toHaveLength(3)
      started[2].up([target(4300)])
      await tick()
      expect(started[3].run.source).toMatchObject({ commit: 'e'.repeat(40) })
    })

    it('starts the services again at the commit, with their volumes, on a backend that moves no other way', async () => {
      const { executor, started } = keeping()
      const registry = new RunRegistry({
        executor,
        up: { maxTtl: HOUR, perCaller: 3, total: 10, keepVolumes: false },
      })
      const run = registry.submit(alice, spec())
      await tick()
      started[0].up([target(4100)])
      registry.move(alice, run.id, at('d'))
      await vi.waitFor(() => expect(started).toHaveLength(2))
      expect(started[0].kept).toBe('volumes')
      expect(started[1].run.source).toMatchObject({ commit: 'd'.repeat(40) })
      // at the commit once its services are up there
      expect(registry.get(alice, run.id)).toMatchObject({
        state: 'running',
        source: { commit: 'c'.repeat(40) },
        moving: { commit: 'd'.repeat(40) },
      })
      started[1].up([target(4200)])
      expect(registry.get(alice, run.id)).toMatchObject({ state: 'up', id: run.id, source: { commit: 'd'.repeat(40) } })
      expect(registry.get(alice, run.id)?.moving).toBeUndefined()
      expect(registry.endpoint('feature-80-abcdef')?.target).toEqual(target(4200))
    })

    it('goes back to the commit it was up at, with its volumes, when the services do not get up at the new one', async () => {
      const { executor, started, forgotten } = keeping()
      const registry = new RunRegistry({ executor })
      const run = registry.submit(alice, spec())
      await tick()
      started[0].up([target(4100)])
      registry.move(alice, run.id, at('d'))
      await vi.waitFor(() => expect(started).toHaveLength(2))
      started[1].fail(new Error('build failed'))
      await vi.waitFor(() => expect(started).toHaveLength(3))
      expect(started[1].kept).toBeUndefined()
      expect(started[2].run.source).toMatchObject({ commit: 'c'.repeat(40) })
      expect(registry.get(alice, run.id)).toMatchObject({
        state: 'running',
        source: { commit: 'c'.repeat(40) },
        moves: [{ commit: 'd'.repeat(40), error: 'build failed' }],
      })
      expect(forgotten).toEqual([])
      started[2].up([target(4300)])
      expect(registry.get(alice, run.id)).toMatchObject({ state: 'up', source: { commit: 'c'.repeat(40) } })
      // the newest of two moves that came while it stopped
      registry.move(alice, run.id, at('d'))
      registry.move(alice, run.id, at('e'))
      await vi.waitFor(() => expect(started).toHaveLength(4))
      expect(started[3].run.source).toMatchObject({ commit: 'e'.repeat(40) })
    })

    it('wakes a run that moved while it slept at the commit it was up at, when the new one does not get up', async () => {
      const { executor, started, forgotten } = keeping(false, true)
      const registry = new RunRegistry({ executor })
      const sleepy = registry.submit(alice, spec('sleepy', HOUR, 20))
      await tick()
      started[0].up([target(4100)])
      await vi.waitFor(() => expect(registry.get(alice, sleepy.id)?.state).toBe('asleep'))
      registry.move(alice, sleepy.id, at('d'))
      registry.visit(sleepy.id)
      await tick()
      expect(started[1].run.source).toMatchObject({ commit: 'd'.repeat(40) })
      started[1].fail(new Error('build failed'))
      await vi.waitFor(() => expect(started).toHaveLength(3))
      expect(started[2].run.source).toMatchObject({ commit: 'c'.repeat(40) })
      expect(registry.get(alice, sleepy.id)?.moves?.map((move) => [move.commit[0], move.error])).toEqual([
        ['d', undefined],
        ['d', 'build failed'],
      ])
      expect(forgotten).toEqual([])
    })

    it('waits for a place of the server to move, and gets as long as a run to be up', async () => {
      const { executor, started } = keeping(false, true)
      const registry = new RunRegistry({ executor, maxConcurrent: 1, maxDuration: 60 })
      const run = registry.submit(alice, spec())
      await tick()
      started[0].up([target(4100)])
      // another run takes the place
      registry.submit(alice, spec('other'))
      await tick()
      expect(started).toHaveLength(2)
      registry.move(alice, run.id, at('d'))
      await tick()
      expect(started).toHaveLength(2)
      expect(registry.get(alice, run.id)?.moving).toMatchObject({ commit: 'd'.repeat(40) })
      started[1].up([target(4200)])
      await vi.waitFor(() => expect(started).toHaveLength(3))
      expect(started[2].run.source).toMatchObject({ commit: 'd'.repeat(40) })
      // the move holds the place: no other run starts beside it
      registry.submit(alice, spec('third'))
      await tick()
      expect(started).toHaveLength(3)
      // it never gets up: stopped after maxDuration, the run stays where it was
      await vi.waitFor(() =>
        expect(registry.get(alice, run.id)?.moves?.[0]?.error).toMatch(/^the move took longer than/)
      )
      expect(registry.get(alice, run.id)).toMatchObject({ state: 'up', source: { commit: 'c'.repeat(40) } })
      await vi.waitFor(() => expect(started).toHaveLength(4))
    })

    it('answers a wait once the run is at the commit, and gives it more time when asked', async () => {
      const now = Date.parse('2026-11-07T10:00:00Z')
      const { executor, started } = keeping(false, true)
      const registry = new RunRegistry({
        executor,
        now: () => now,
        up: { maxTtl: 4 * HOUR, perCaller: 3, total: 10 },
      })
      const run = registry.submit(alice, spec('feature', HOUR))
      await tick()
      started[0].up([target(4100)])
      expect(registry.move(alice, run.id, { ...at('d'), ttl: 3 * HOUR })?.expiresAt).toBe('2026-11-07T13:00:00.000Z')
      let answered = false
      const waiting = registry.wait(alice, run.id, 5000).then((answer) => {
        answered = true
        return answer
      })
      await tick()
      expect(answered).toBe(false)
      started[1].up([target(4200)])
      expect(await waiting).toMatchObject({ source: { commit: 'd'.repeat(40) } })
      // not somebody else's, nor one that ended
      expect(registry.move(bob, run.id, at('e'))).toBeUndefined()
      registry.cancel(alice, run.id)
      await vi.waitFor(() => expect(registry.get(alice, run.id)?.state).toBe('succeeded'))
      expect(registry.move(alice, run.id, at('e'))).toBeUndefined()
    })
  })

  it('ends when it is stopped, also once its sleepTtl passes while its services stop', async () => {
    const { executor, started } = keeping(true)
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, spec('feature', HOUR, 100))
    await tick()
    started[0].up([target(4100)])
    registry.cancel(alice, run.id)
    // its services take longer to stop than its sleepTtl
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(started[0].kept).toBe('nothing')
    started[0].end()
    await vi.waitFor(() => expect(registry.get(alice, run.id)).toMatchObject({ state: 'succeeded', stoppedBy: alice }))
  })

  it('ends when a stop comes while its services stop to sleep', async () => {
    const { executor, started } = keeping(true)
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, spec('feature', HOUR, 100))
    await tick()
    started[0].up([target(4100)])
    await vi.waitFor(() => expect(started[0].signal.aborted).toBe(true))
    registry.cancel(alice, run.id)
    started[0].end()
    await vi.waitFor(() => expect(registry.get(alice, run.id)).toMatchObject({ state: 'succeeded', stoppedBy: alice }))
  })

  it('is not made to end sooner by an extend', async () => {
    const now = Date.parse('2026-10-25T10:00:00Z')
    const { executor, started } = services()
    const registry = new RunRegistry({ executor, now: () => now, up: { maxTtl: 4 * HOUR, perCaller: 3, total: 10 } })
    const run = registry.submit(alice, spec('feature', 2 * HOUR))
    await tick()
    started[0].up([target(4100)])
    expect(registry.extend(bob, run.id, 1000, () => true)).toMatchObject({
      run: { expiresAt: '2026-10-25T12:00:00.000Z' },
    })
  })

  it('refuses a run whose address is another run of somebody else', async () => {
    const { executor } = services()
    const registry = new RunRegistry({ executor })
    registry.submit(alice, spec())
    expect(() => registry.submit(bob, spec())).toThrow(/is another service run's/)
    // of the same owner and name, it replaces the first once up
    expect(() => registry.submit(alice, spec())).not.toThrow()
    const other = spec('other')
    other.up.endpoints = [{ ...other.up.endpoints[0], host: 'feature-80-abcdef' }]
    expect(() => registry.submit(alice, other)).toThrow(/is another service run's/)
  })
})
