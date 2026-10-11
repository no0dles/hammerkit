import { RunExecutor, RunRegistry, unavailableExecutor } from './runs'

const alice = { iss: 'https://idp.corp', sub: 'alice' }
const bob = { iss: 'https://idp.corp', sub: 'bob' }
const spec = {
  definition: { name: 'payments', hash: 'sha256:' + 'a'.repeat(64) },
  tasks: ['build'],
  account: null,
  source: { type: 'ref' as const, ref: 'main' },
  options: {},
}

// an executor the test finishes by hand
function manual() {
  const pending: { resolve: () => void; reject: (e: Error) => void; signal: AbortSignal; emit: (e: any) => void }[] = []
  const executor: RunExecutor = {
    execute: (_run, context) =>
      new Promise<void>((resolve, reject) => {
        pending.push({ resolve, reject, signal: context.signal, emit: context.emit })
        context.signal.addEventListener('abort', () => reject(new Error('aborted')))
      }),
  }
  return { executor, pending }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('RunRegistry', () => {
  it('runs a submitted run to its end and keeps the state changes as events', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, spec)
    expect(run.id).toMatch(/^run_[A-Za-z0-9_-]{16}$/)
    await tick()
    expect(registry.get(alice, run.id)?.state).toBe('running')

    pending[0].emit({ type: 'log', task: 'build', stream: 'stdout', text: 'hello' })
    pending[0].resolve()
    await tick()

    const done = registry.get(alice, run.id)
    expect(done).toMatchObject({ state: 'succeeded', tasks: ['build'] })
    expect(done?.startedAt).toBeDefined()
    expect(done?.finishedAt).toBeDefined()
    const watch = registry.watch(alice, run.id, 0, () => undefined)
    expect(watch?.finished).toBe(true)
    expect(watch?.events.map((e) => [e.seq, e.type])).toEqual([
      [1, 'state'],
      [2, 'state'],
      [3, 'log'],
      [4, 'state'],
    ])
    expect(registry.watch(alice, run.id, 3, () => undefined)?.events).toHaveLength(1)
  })

  it('fails a run whose executor throws, with the reason', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, spec)
    await tick()
    pending[0].reject(new Error('task build failed'))
    await tick()
    expect(registry.get(alice, run.id)).toMatchObject({ state: 'failed', error: 'task build failed' })
  })

  it('fails every run while no backend can execute it', async () => {
    const registry = new RunRegistry({ executor: unavailableExecutor })
    const run = registry.submit(alice, spec)
    await tick()
    expect(registry.get(alice, run.id)).toMatchObject({
      state: 'failed',
      error: 'this server has no backend that can execute runs yet',
    })
  })

  it('shows a run only to the caller who submitted it', async () => {
    const { executor } = manual()
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, spec)
    expect(registry.get(bob, run.id)).toBeUndefined()
    expect(registry.cancel(bob, run.id)).toBeUndefined()
    expect(registry.watch(bob, run.id, 0, () => undefined)).toBeUndefined()
    expect(registry.list(bob)).toEqual([])
    expect(registry.list(alice).map((r) => r.id)).toEqual([run.id])
    // same sub at another issuer is another caller
    expect(registry.get({ iss: 'https://other', sub: 'alice' }, run.id)).toBeUndefined()
    await registry.close()
  })

  it('queues runs beyond the concurrency limit and starts them as others finish', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor, maxConcurrent: 1 })
    const first = registry.submit(alice, spec)
    const second = registry.submit(alice, spec)
    await tick()
    expect(registry.get(alice, first.id)?.state).toBe('running')
    expect(registry.get(alice, second.id)?.state).toBe('queued')
    pending[0].resolve()
    await tick()
    expect(registry.get(alice, second.id)?.state).toBe('running')
    pending[1].resolve()
    await tick()
  })

  it('cancels a queued run at once and aborts a running one', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor, maxConcurrent: 1 })
    const running = registry.submit(alice, spec)
    const queued = registry.submit(alice, spec)
    await tick()
    expect(registry.cancel(alice, queued.id)?.state).toBe('cancelled')
    registry.cancel(alice, running.id)
    expect(pending[0].signal.aborted).toBe(true)
    await tick()
    expect(registry.get(alice, running.id)).toMatchObject({ state: 'cancelled' })
    expect(registry.get(alice, running.id)?.error).toBeUndefined()
    expect(pending).toHaveLength(1)
  })

  it('tells watchers about new events until the run is over', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, spec)
    await tick()
    const seen: string[] = []
    const watch = registry.watch(alice, run.id, 0, (e) => seen.push(e.type))
    expect(watch?.finished).toBe(false)
    pending[0].emit({ type: 'task', task: 'build', state: 'running' })
    pending[0].resolve()
    await tick()
    expect(seen).toEqual(['task', 'state'])
  })

  it('cuts a run off that says too much, but keeps its state changes', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor, maxEvents: 5 })
    const run = registry.submit(alice, spec)
    await tick()
    for (let i = 0; i < 20; i++) {
      pending[0].emit({ type: 'log', task: 'build', stream: 'stdout', text: String(i) })
    }
    pending[0].resolve()
    await tick()
    const events = registry.watch(alice, run.id, 0, () => undefined)?.events ?? []
    expect(events.filter((e) => e.type === 'log')).toHaveLength(3)
    expect(events.filter((e) => e.type === 'truncated')).toHaveLength(1)
    expect(events[events.length - 1]).toMatchObject({ type: 'state', state: 'succeeded' })
  })

  it('forgets the oldest finished runs and never one that is still going', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor, keep: 2, maxConcurrent: 10 })
    const ids = [1, 2, 3, 4].map(() => registry.submit(alice, spec).id)
    await tick()
    pending.forEach((p) => p.resolve())
    await tick()
    const running = registry.submit(alice, spec).id
    await tick()
    expect(
      registry
        .list(alice)
        .map((r) => r.id)
        .sort()
    ).toEqual([ids[2], ids[3], running].sort())
    pending[4].resolve()
    await tick()
  })

  it('stops accepting runs and aborts the running ones when it is closed', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor, maxConcurrent: 1 })
    const running = registry.submit(alice, spec)
    const queued = registry.submit(alice, spec)
    await tick()
    await registry.close()
    expect(pending[0].signal.aborted).toBe(true)
    expect(registry.get(alice, running.id)?.state).toBe('cancelled')
    expect(registry.get(alice, queued.id)?.state).toBe('cancelled')
    expect(() => registry.submit(alice, spec)).toThrow('shutting down')
  })
})
