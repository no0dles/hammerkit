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

describe('RunRegistry approvals', () => {
  const rules = [
    { index: 0, name: 'production' },
    { index: 2, name: 'data' },
  ]
  // what the server decides from the config: bob may decide rule 0, dba rule 2, carol both
  const may = (who: string) => (rule: number) =>
    (who === 'bob' && rule === 0) || (who === 'dba' && rule === 2) || (who === 'carol' && (rule === 0 || rule === 2))
  const person = (sub: string) => ({ iss: 'https://idp.corp', sub })

  it('holds a run that falls under a rule and does not execute it', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, spec, rules)
    await tick()
    expect(pending).toHaveLength(0)
    expect(run.state).toBe('awaiting-approval')
    expect(run.approval?.rules.map((r) => r.name)).toEqual(['production', 'data'])
    expect(new Date(run.approval?.expiresAt as string).getTime()).toBeGreaterThan(Date.now())
    expect(registry.get(alice, run.id)?.state).toBe('awaiting-approval')
    expect(registry.waiting().map((r) => r.id)).toEqual([run.id])
    await registry.close()
  })

  it('queues the run once every rule has an approval, and says who gave them', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, spec, rules)

    const first = registry.decide(person('bob'), run.id, 'approved', may('bob'))
    expect(first).toMatchObject({ status: 'ok', run: { state: 'awaiting-approval' } })
    await tick()
    expect(pending).toHaveLength(0)
    // the same rule is not asked twice, and the one left is the dba's
    expect(registry.decide(person('bob'), run.id, 'approved', may('bob'))).toEqual({
      status: 'not-waiting',
      state: 'awaiting-approval',
    })

    const second = registry.decide(person('dba'), run.id, 'approved', may('dba'))
    expect(second).toMatchObject({ status: 'ok', run: { state: 'queued' } })
    await tick()
    expect(pending).toHaveLength(1)
    const approved = registry.get(alice, run.id)
    expect(approved?.approval?.rules.map((r) => [r.name, r.approvedBy?.sub])).toEqual([
      ['production', 'bob'],
      ['data', 'dba'],
    ])
    expect(registry.waiting()).toEqual([])
    pending[0].resolve()
    await tick()
    expect(registry.get(alice, run.id)?.state).toBe('succeeded')
    const watch = registry.watch(alice, run.id, 0, () => undefined)
    expect(watch?.events.map((e) => (e.type === 'state' ? e.state : e.type))).toEqual([
      'awaiting-approval',
      'approval',
      'approval',
      'queued',
      'running',
      'succeeded',
    ])
  })

  it('takes one approval for all the rules of an approver', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, spec, rules)
    expect(registry.decide(person('carol'), run.id, 'approved', may('carol'))).toMatchObject({
      status: 'ok',
      run: { state: 'queued' },
    })
    await tick()
    expect(pending).toHaveLength(1)
    pending[0].resolve()
    await tick()
  })

  it('ends the run when an approver rejects it, with their reason', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, spec, rules)
    const result = registry.decide(person('dba'), run.id, 'rejected', may('dba'), 'not on a friday')
    expect(result).toMatchObject({
      status: 'ok',
      run: { state: 'rejected', error: 'rejected by dba: not on a friday' },
    })
    await tick()
    expect(pending).toHaveLength(0)
    expect(registry.waiting()).toEqual([])
    const watch = registry.watch(alice, run.id, 0, () => undefined)
    expect(watch?.finished).toBe(true)
    expect(watch?.events.find((e) => e.type === 'approval')).toMatchObject({
      outcome: 'rejected',
      by: person('dba'),
      rules: ['data'],
      reason: 'not on a friday',
    })
    // it is over: nothing to approve or reject any more
    expect(registry.decide(person('bob'), run.id, 'approved', may('bob'))).toEqual({
      status: 'not-waiting',
      state: 'rejected',
    })
  })

  it('does not let anyone decide on their own run, and shows it to approvers only', () => {
    const registry = new RunRegistry({ executor: unavailableExecutor })
    const run = registry.submit(person('bob'), spec, rules)
    expect(registry.decide(person('bob'), run.id, 'approved', may('bob'))).toEqual({ status: 'own-run' })
    expect(registry.decide(person('mallory'), run.id, 'approved', may('mallory'))).toEqual({ status: 'not-found' })
    expect(registry.decide(person('bob'), 'run_unknown', 'approved', may('bob'))).toEqual({ status: 'not-found' })
    expect(registry.getForApproval(person('mallory'), run.id, may('mallory'))).toBeUndefined()
    expect(registry.getForApproval(person('dba'), run.id, may('dba'))?.id).toBe(run.id)
    expect(registry.get(person('bob'), run.id)?.state).toBe('awaiting-approval')
    expect(registry.get(person('dba'), run.id)).toBeUndefined()
    expect(registry.get(person('bob'), run.id)?.approval?.rules[0].approvedBy).toBeUndefined()
  })

  it('rejects a run nobody approved in time', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor, approvalTimeout: 20 })
    const run = registry.submit(alice, spec, rules)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(registry.get(alice, run.id)).toMatchObject({ state: 'rejected', error: 'nobody approved it in time' })
    expect(pending).toHaveLength(0)
    expect(registry.decide(person('bob'), run.id, 'approved', may('bob'))).toMatchObject({ status: 'not-waiting' })
  })

  it('does not reject a run that was approved before its time ran out', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor, approvalTimeout: 40 })
    const run = registry.submit(alice, spec, [rules[0]])
    registry.decide(person('bob'), run.id, 'approved', may('bob'))
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(registry.get(alice, run.id)?.state).toBe('running')
    pending[0].resolve()
    await tick()
  })

  it('lets the caller withdraw a run that waits', () => {
    const registry = new RunRegistry({ executor: unavailableExecutor })
    const run = registry.submit(alice, spec, rules)
    expect(registry.cancel(alice, run.id)?.state).toBe('cancelled')
    expect(registry.waiting()).toEqual([])
    expect(registry.decide(person('bob'), run.id, 'approved', may('bob'))).toMatchObject({ status: 'not-waiting' })
  })

  it('only holds so many runs, the others are refused', async () => {
    const registry = new RunRegistry({ executor: unavailableExecutor, maxWaiting: 2 })
    const first = registry.submit(alice, spec, rules)
    registry.submit(alice, spec, rules)
    expect(() => registry.submit(alice, spec, rules)).toThrow('too many runs are waiting for an approval')
    // runs without a rule are not held, and a decided one makes room
    expect(registry.submit(alice, spec).state).toBe('queued')
    registry.cancel(alice, first.id)
    expect(registry.submit(alice, spec, rules).state).toBe('awaiting-approval')
    await registry.close()
  })

  it('cancels the runs that wait when it is closed', async () => {
    const registry = new RunRegistry({ executor: unavailableExecutor })
    const run = registry.submit(alice, spec, rules)
    await registry.close()
    expect(registry.get(alice, run.id)?.state).toBe('cancelled')
  })
})
