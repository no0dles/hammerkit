import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EndpointTarget, QuotaError, RunError, RunExecutor, RunRegistry, ServiceRunSpec } from './runs'
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

  it('sleeps without a request for its sleepTtl, and wakes on the next, as the same run', async () => {
    const { executor, started } = services()
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, spec('feature', HOUR, 40))
    await tick()
    started[0].up([target(4100)])
    const expiresAt = registry.get(alice, run.id)?.expiresAt
    // a request keeps it up
    await new Promise((resolve) => setTimeout(resolve, 25))
    registry.visit(run.id)
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(registry.get(alice, run.id)?.state).toBe('up')
    await new Promise((resolve) => setTimeout(resolve, 40))
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
