import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { QuotaError, Run, RunExecutor, RunRegistry, unavailableExecutor } from './runs'
import { FileRunStore } from './run-store'

const alice = { iss: 'https://idp.corp', sub: 'alice' }
const bob = { iss: 'https://idp.corp', sub: 'bob' }
const spec = {
  definition: 'sha256:' + 'a'.repeat(64),
  tasks: ['build'],
  accounts: [] as string[],
  source: { type: 'ref' as const, repo: 'github.com/corp/payments', ref: 'main', commit: 'c'.repeat(40) },
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
  // an approver uses the accounts the server grants them
  const prod = { ...spec, accounts: ['prod'] }
  const may = (who: string) => (account: string) => who === 'ops' && account === 'prod'
  const person = (sub: string) => ({ iss: 'https://idp.corp', sub })

  it('holds a run that needs an approval and does not execute it', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, prod, ['prod'])
    await tick()
    expect(pending).toHaveLength(0)
    expect(run.state).toBe('awaiting-approval')
    expect(new Date(run.approvals?.[0].expiresAt as string).getTime()).toBeGreaterThan(Date.now())
    expect(registry.get(alice, run.id)?.state).toBe('awaiting-approval')
    expect(registry.waiting().map((r) => r.id)).toEqual([run.id])
    await registry.close()
  })

  it('queues the run once an admin approved it, and says who did', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, prod, ['prod'])

    expect(registry.decide(person('dev'), run.id, 'approved', may('dev'))).toEqual({ status: 'not-found' })
    await tick()
    expect(pending).toHaveLength(0)

    const result = registry.decide(person('ops'), run.id, 'approved', may('ops'))
    expect(result).toMatchObject({ status: 'ok', run: { state: 'queued' } })
    await tick()
    expect(pending).toHaveLength(1)
    expect(registry.get(alice, run.id)?.approvals?.[0].approvedBy).toEqual(person('ops'))
    expect(registry.waiting()).toEqual([])
    pending[0].resolve()
    await tick()
    expect(registry.get(alice, run.id)?.state).toBe('succeeded')
    const watch = registry.watch(alice, run.id, 0, () => undefined)
    expect(watch?.events.map((e) => (e.type === 'state' ? e.state : e.type))).toEqual([
      'awaiting-approval',
      'approval',
      'queued',
      'running',
      'succeeded',
    ])
    // decided once
    expect(registry.decide(person('ops'), run.id, 'rejected', may('ops'))).toEqual({
      status: 'not-waiting',
      state: 'succeeded',
    })
  })

  it('ends the run when an admin rejects it, with their reason', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, prod, ['prod'])
    const result = registry.decide(person('ops'), run.id, 'rejected', may('ops'), 'not on a friday')
    expect(result).toMatchObject({
      status: 'ok',
      run: { state: 'rejected', error: 'rejected by ops: not on a friday' },
    })
    await tick()
    expect(pending).toHaveLength(0)
    expect(registry.waiting()).toEqual([])
    const watch = registry.watch(alice, run.id, 0, () => undefined)
    expect(watch?.finished).toBe(true)
    expect(watch?.events.find((e) => e.type === 'approval')).toMatchObject({
      outcome: 'rejected',
      by: person('ops'),
      accounts: ['prod'],
      reason: 'not on a friday',
    })
    expect(registry.decide(person('ops'), run.id, 'approved', may('ops'))).toEqual({
      status: 'not-waiting',
      state: 'rejected',
    })
  })

  it('does not let anyone decide on their own run, and shows it to admins of the account only', () => {
    const registry = new RunRegistry({ executor: unavailableExecutor })
    const run = registry.submit(person('ops'), prod, ['prod'])
    expect(registry.decide(person('ops'), run.id, 'approved', may('ops'))).toEqual({ status: 'own-run' })
    expect(registry.decide(person('mallory'), run.id, 'approved', may('mallory'))).toEqual({ status: 'not-found' })
    expect(registry.decide(person('ops'), 'run_unknown', 'approved', may('ops'))).toEqual({ status: 'not-found' })
    expect(registry.getForApproval(run.id, may('mallory'))).toBeUndefined()
    expect(registry.getForApproval(run.id, may('ops'))?.id).toBe(run.id)
    expect(registry.get(person('ops'), run.id)?.state).toBe('awaiting-approval')
    expect(registry.get(person('mallory'), run.id)).toBeUndefined()
    expect(registry.get(person('ops'), run.id)?.approvals?.[0].approvedBy).toBeUndefined()
  })

  it('does not let an admin of another account decide', () => {
    const registry = new RunRegistry({ executor: unavailableExecutor })
    const run = registry.submit(alice, { ...prod, accounts: ['dev'] }, ['dev'])
    expect(registry.decide(person('ops'), run.id, 'approved', may('ops'))).toEqual({ status: 'not-found' })
    expect(registry.getForApproval(run.id, may('ops'))).toBeUndefined()
  })

  it('rejects a run nobody approved in time', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor, approvalTimeout: 20 })
    const run = registry.submit(alice, prod, ['prod'])
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(registry.get(alice, run.id)).toMatchObject({ state: 'rejected', error: 'nobody approved it in time' })
    expect(pending).toHaveLength(0)
    expect(registry.decide(person('ops'), run.id, 'approved', may('ops'))).toMatchObject({ status: 'not-waiting' })
  })

  it('does not reject a run that was approved before its time ran out', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor, approvalTimeout: 40 })
    const run = registry.submit(alice, prod, ['prod'])
    registry.decide(person('ops'), run.id, 'approved', may('ops'))
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(registry.get(alice, run.id)?.state).toBe('running')
    pending[0].resolve()
    await tick()
  })

  it('lets the caller withdraw a run that waits', () => {
    const registry = new RunRegistry({ executor: unavailableExecutor })
    const run = registry.submit(alice, prod, ['prod'])
    expect(registry.cancel(alice, run.id)?.state).toBe('cancelled')
    expect(registry.waiting()).toEqual([])
    expect(registry.decide(person('ops'), run.id, 'approved', may('ops'))).toMatchObject({ status: 'not-waiting' })
  })

  it('only holds so many runs, the others are refused', async () => {
    const registry = new RunRegistry({ executor: unavailableExecutor, maxWaiting: 2 })
    const first = registry.submit(alice, prod, ['prod'])
    registry.submit(alice, prod, ['prod'])
    expect(() => registry.submit(alice, prod, ['prod'])).toThrow('too many runs are waiting for an approval')
    // runs that need none are not held, and a decided one makes room
    expect(registry.submit(alice, spec).state).toBe('queued')
    registry.cancel(alice, first.id)
    expect(registry.submit(alice, prod, ['prod']).state).toBe('awaiting-approval')
    await registry.close()
  })

  describe('several accounts', () => {
    const both = { ...spec, accounts: ['dev', 'prod'] }
    const uses =
      (who: string, ...accounts: string[]) =>
      (account: string) =>
        who === 'ops' ? accounts.includes(account) : who === 'dba' ? account === 'db' : false

    it('is released by one approver who uses all the accounts that wait', async () => {
      const { executor, pending } = manual()
      const registry = new RunRegistry({ executor })
      const run = registry.submit(alice, both, ['dev', 'prod'])
      expect(run.approvals?.map((a) => a.account)).toEqual(['dev', 'prod'])
      // one expiry for the run
      expect(new Set(run.approvals?.map((a) => a.expiresAt)).size).toBe(1)
      const result = registry.decide(person('ops'), run.id, 'approved', uses('ops', 'dev', 'prod'))
      expect(result).toMatchObject({ status: 'ok', run: { state: 'queued' } })
      await tick()
      expect(pending).toHaveLength(1)
      pending[0].resolve()
      await tick()
    })

    it('keeps waiting while an account is not covered, and asks for the others', async () => {
      const { executor, pending } = manual()
      const registry = new RunRegistry({ executor })
      const run = registry.submit(alice, { ...both, accounts: ['db', 'prod'] }, ['db', 'prod'])
      const first = registry.decide(person('ops'), run.id, 'approved', uses('ops', 'prod'))
      expect(first).toMatchObject({ status: 'ok', run: { state: 'awaiting-approval' } })
      await tick()
      expect(pending).toHaveLength(0)
      expect(registry.get(alice, run.id)?.approvals?.map((a) => [a.account, a.approvedBy?.sub])).toEqual([
        ['db', undefined],
        ['prod', 'ops'],
      ])
      // the first approver has nothing more to give; the run is still listed for who can cover db
      expect(registry.decide(person('ops'), run.id, 'approved', uses('ops', 'prod'))).toEqual({
        status: 'already-approved',
      })
      const second = registry.decide(person('dba'), run.id, 'approved', uses('dba'))
      expect(second).toMatchObject({ status: 'ok', run: { state: 'queued' } })
      await tick()
      expect(pending).toHaveLength(1)
      pending[0].resolve()
      await tick()
    })

    it('ends the run when anybody who covers one of the accounts rejects it', () => {
      const registry = new RunRegistry({ executor: unavailableExecutor })
      const run = registry.submit(alice, { ...both, accounts: ['db', 'prod'] }, ['db', 'prod'])
      registry.decide(person('ops'), run.id, 'approved', uses('ops', 'prod'))
      const result = registry.decide(person('dba'), run.id, 'rejected', uses('dba'), 'no')
      expect(result).toMatchObject({ status: 'ok', run: { state: 'rejected' } })
    })

    it('hides the run from who uses none of its accounts', () => {
      const registry = new RunRegistry({ executor: unavailableExecutor })
      const run = registry.submit(alice, { ...both, accounts: ['db', 'prod'] }, ['db', 'prod'])
      expect(registry.decide(person('mallory'), run.id, 'approved', uses('mallory'))).toEqual({ status: 'not-found' })
    })
  })

  it('cancels the runs that wait when it is closed', async () => {
    const registry = new RunRegistry({ executor: unavailableExecutor })
    const run = registry.submit(alice, prod, ['prod'])
    await registry.close()
    expect(registry.get(alice, run.id)?.state).toBe('cancelled')
  })
})

describe('RunRegistry limits', () => {
  const prod = { ...spec, accounts: ['prod'] }

  it('refuses a caller more queued runs than their limit, others may still submit', async () => {
    const { executor } = manual()
    const registry = new RunRegistry({
      executor,
      maxConcurrent: 1,
      limits: { waiting: 5, queued: 2, running: 5 },
    })
    registry.submit(alice, spec)
    await tick()
    registry.submit(alice, spec)
    registry.submit(alice, spec)
    expect(() => registry.submit(alice, spec)).toThrow(/2 runs in the queue/)
    try {
      registry.submit(alice, spec)
    } catch (e) {
      expect((e as QuotaError).status).toBe(429)
    }
    expect(registry.submit(bob, spec).state).toBe('queued')
    await registry.close()
  })

  it('refuses a caller more waiting runs than their limit', async () => {
    const registry = new RunRegistry({ executor: unavailableExecutor, limits: { waiting: 1, queued: 5, running: 5 } })
    registry.submit(alice, prod, ['prod'])
    expect(() => registry.submit(alice, prod, ['prod'])).toThrow(/1 runs waiting for an approval/)
    expect(registry.submit(bob, prod, ['prod']).state).toBe('awaiting-approval')
    await registry.close()
  })

  it('does not let one caller keep the others from the machine', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor, maxConcurrent: 2, limits: { waiting: 5, queued: 5, running: 1 } })
    const first = registry.submit(alice, spec)
    const second = registry.submit(alice, spec)
    const other = registry.submit(bob, spec)
    await tick()
    expect(pending).toHaveLength(2)
    expect(registry.get(alice, first.id)?.state).toBe('running')
    expect(registry.get(alice, second.id)?.state).toBe('queued')
    expect(registry.get(bob, other.id)?.state).toBe('running')
    pending[0].resolve()
    await tick()
    expect(registry.get(alice, second.id)?.state).toBe('running')
    await registry.close()
  })

  it('keeps a caller’s runs queued, without a timer, while the backend runs one at a time per caller', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({
      executor: { ...executor, runningPerCaller: 1 },
      maxConcurrent: 4,
      maxDuration: 200,
      limits: { waiting: 5, queued: 5, running: 2 },
    })
    const first = registry.submit(alice, spec)
    const second = registry.submit(alice, spec)
    const other = registry.submit(bob, spec)
    await tick()
    expect(pending).toHaveLength(2)
    expect(registry.get(alice, second.id)?.state).toBe('queued')
    expect(registry.get(bob, other.id)?.state).toBe('running')
    while (registry.get(alice, first.id)?.state === 'running') {
      await tick()
    }
    // the first one ran out of time; the second only starts now, with a timer of its own
    expect(registry.get(alice, first.id)?.state).toBe('failed')
    expect(registry.get(alice, second.id)?.state).toBe('running')
    await registry.close()
  })

  it('stops a run that takes longer than the maximum, and says why', async () => {
    const { executor } = manual()
    const registry = new RunRegistry({ executor, maxDuration: 20 })
    const run = registry.submit(alice, spec)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(registry.get(alice, run.id)).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/took longer than .* and was stopped/),
    })
  })

  it('keeps no more log output than the maximum, but every state change', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor, maxLogBytes: 300 })
    const run = registry.submit(alice, spec)
    await tick()
    for (let i = 0; i < 20; i++) {
      pending[0].emit({ type: 'log', task: 'build', stream: 'stdout', text: 'x'.repeat(100) })
    }
    pending[0].resolve()
    await tick()
    const events = registry.watch(alice, run.id, 0, () => undefined)?.events ?? []
    expect(events.filter((e) => e.type === 'log').length).toBeLessThan(5)
    expect(events.filter((e) => e.type === 'truncated')).toHaveLength(1)
    expect(events[events.length - 1]).toMatchObject({ type: 'state', state: 'succeeded' })
  })
})

describe('RunRegistry results', () => {
  it('keeps a result small whatever an executor says of its causes and error', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor, maxLogBytes: 1024, maxEvents: 10 })
    const run = registry.submit(alice, { ...spec, tasks: ['build', 'test'] })
    await tick()
    const causes = Array.from({ length: 10_000 }, (_, i) => `source changed: src/${i}.ts`)
    pending[0].emit({ type: 'task', task: 'build', state: 'succeeded', durationMs: 1, causes })
    pending[0].emit({ type: 'task', task: 'test', state: 'failed', error: 'e'.repeat(1_000_000) })
    pending[0].reject(new Error('test failed'))
    await tick()

    const stored = registry.get(alice, run.id)
    expect(JSON.stringify(stored).length).toBeLessThan(64 * 1024)
    expect(stored?.results?.build.cache?.causes).toHaveLength(21)
    expect(stored?.results?.build.cache?.causes?.[20]).toBe('… and 9980 more')
    expect(stored?.results?.test.error).toHaveLength(2048)
    const events = registry.logs(alice, run.id)?.events ?? []
    expect(JSON.stringify(events).length).toBeLessThan(64 * 1024)
  })

  it('keeps a result per task: how it ended, how long it took, the cache and its last lines', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, { ...spec, tasks: ['build', 'test'] })
    expect(registry.get(alice, run.id)?.results).toBeUndefined()
    await tick()
    pending[0].emit({ type: 'task', task: 'build', state: 'cached', durationMs: 2 })
    pending[0].emit({ type: 'task', task: 'test', state: 'running' })
    pending[0].emit({ type: 'log', task: 'test', stream: 'stdout', text: 'one\ntwo\n' })
    expect(registry.get(alice, run.id)?.results?.test).toEqual({
      status: 'running',
      startedAt: expect.any(String),
      lastLog: ['one', 'two'],
    })
    pending[0].emit({ type: 'log', task: 'test', stream: 'stderr', text: 'expected 1 to be 2' })
    pending[0].emit({
      type: 'task',
      task: 'test',
      state: 'failed',
      exitCode: 1,
      durationMs: 1500,
      causes: ['source changed: src/a.ts'],
    })
    pending[0].reject(new Error('test failed'))
    await tick()

    const results = registry.get(alice, run.id)?.results
    expect(results?.build).toEqual({
      status: 'cached',
      finishedAt: expect.any(String),
      durationMs: 2,
      cache: { hit: true },
      lastLog: [],
    })
    expect(results?.test).toEqual({
      status: 'failed',
      startedAt: expect.any(String),
      finishedAt: expect.any(String),
      durationMs: 1500,
      exitCode: 1,
      cache: { hit: false, causes: ['source changed: src/a.ts'] },
      lastLog: ['one', 'two', 'expected 1 to be 2'],
    })
  })

  it('keeps the last lines of a task when the log of the run was cut off', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor, maxEvents: 5 })
    const run = registry.submit(alice, spec)
    await tick()
    pending[0].emit({ type: 'task', task: 'build', state: 'running' })
    for (let i = 0; i < 100; i++) {
      pending[0].emit({ type: 'log', task: 'build', stream: 'stdout', text: `line ${i}` })
    }
    pending[0].emit({ type: 'log', task: 'build', stream: 'stdout', text: 'x'.repeat(5000) })
    pending[0].emit({ type: 'task', task: 'build', state: 'failed', exitCode: 2 })
    pending[0].reject(new Error('build failed'))
    await tick()
    const result = registry.get(alice, run.id)?.results?.build
    expect(result?.status).toBe('failed')
    expect(result?.lastLog).toHaveLength(20)
    expect(result?.lastLog[18]).toBe('line 99')
    // a long line is cut, the result stays small
    expect(result?.lastLog[19]).toBe(`${'x'.repeat(1000)}…`)
    // the task event itself was cut off with the log, its result was not
    const events = registry.watch(alice, run.id, 0, () => undefined)?.events ?? []
    expect(events.filter((e) => e.type === 'task').map((e) => (e.type === 'task' ? e.state : ''))).toEqual(['running'])
    expect(registry.logs(alice, run.id)?.truncated).toBe(true)
  })

  it('keeps what a task did when a later scope of the run finds it cached, not needed or stopped', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, { ...spec, tasks: ['build', 'test', 'lint'] })
    await tick()
    // scope build
    pending[0].emit({ type: 'task', task: 'build', state: 'running' })
    pending[0].emit({ type: 'task', task: 'build', state: 'succeeded', durationMs: 900, causes: ['never cached'] })
    // scope test: build is a dependency again and now cached
    pending[0].emit({ type: 'task', task: 'build', state: 'cached', durationMs: 1 })
    pending[0].emit({ type: 'task', task: 'test', state: 'running' })
    pending[0].emit({ type: 'task', task: 'test', state: 'failed', exitCode: 1 })
    // scope lint: build not needed, test stopped with it
    pending[0].emit({ type: 'task', task: 'build', state: 'skipped' })
    pending[0].emit({ type: 'task', task: 'test', state: 'cancelled' })
    pending[0].resolve()
    await tick()
    const results = registry.get(alice, run.id)?.results
    expect(results?.build).toMatchObject({
      status: 'succeeded',
      durationMs: 900,
      cache: { hit: false, causes: ['never cached'] },
    })
    expect(results?.test).toMatchObject({ status: 'failed', exitCode: 1 })
  })

  it('weighs task events against the limits of the log, with all their causes', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor, maxLogBytes: 1000 })
    const run = registry.submit(alice, spec)
    await tick()
    const causes = Array.from({ length: 20 }, (_, i) => `source changed: src/${'x'.repeat(60)}-${i}.ts`)
    pending[0].emit({ type: 'task', task: 'build', state: 'succeeded', causes })
    pending[0].resolve()
    await tick()
    const events = registry.watch(alice, run.id, 0, () => undefined)?.events ?? []
    expect(events.map((e) => e.type)).toEqual(['state', 'state', 'truncated', 'state'])
    expect(registry.get(alice, run.id)?.results?.build.cache?.causes).toEqual(causes)
  })

  it('calls a task cancelled that was running when the run ended', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, spec)
    await tick()
    pending[0].emit({ type: 'task', task: 'build', state: 'running' })
    registry.cancel(alice, run.id)
    await tick()
    expect(registry.get(alice, run.id)?.results?.build).toMatchObject({
      status: 'cancelled',
      finishedAt: expect.any(String),
    })
  })

  it('answers a wait when the run is over, or with the run as it is when the time is up', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, spec)
    await tick()
    const started = Date.now()
    expect((await registry.wait(alice, run.id, 30))?.state).toBe('running')
    expect(Date.now() - started).toBeGreaterThanOrEqual(25)

    const waiting = registry.wait(alice, run.id, 10_000)
    pending[0].resolve()
    expect((await waiting)?.state).toBe('succeeded')
    // over already, at once
    expect((await registry.wait(alice, run.id, 10_000))?.state).toBe('succeeded')
    expect(await registry.wait(bob, run.id, 10)).toBeUndefined()
  })

  it('stops waiting when the caller goes away or the server stops', async () => {
    const { executor } = manual()
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, spec)
    await tick()
    const gone = new AbortController()
    const waiting = registry.wait(alice, run.id, 10_000, undefined, gone.signal)
    gone.abort()
    expect((await waiting)?.state).toBe('running')

    const approval = registry.submit(alice, spec, ['prod'])
    const stopping = registry.wait(alice, approval.id, 10_000)
    await registry.close()
    expect((await stopping)?.state).toBe('cancelled')
  })

  it('reads the log of a run for its caller only', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, spec)
    await tick()
    pending[0].emit({ type: 'log', task: 'build', stream: 'stdout', text: 'hello' })
    const logs = registry.logs(alice, run.id)
    expect(logs?.truncated).toBe(false)
    expect(logs?.index.size).toBe(1)
    expect(logs?.index.text(logs.events, 0)).toEqual({ task: 'build', stream: 'stdout', text: 'hello' })
    expect(registry.logs(bob, run.id)).toBeUndefined()
    pending[0].resolve()
    await tick()
  })
})

describe('RunRegistry store', () => {
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'hammerkit-records-'))
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  const prod = { ...spec, accounts: ['prod'] }

  it('keeps a finished run with its logs over a restart', async () => {
    const { executor, pending } = manual()
    const first = new RunRegistry({ executor, store: new FileRunStore(directory) })
    const run = first.submit(alice, spec)
    await tick()
    pending[0].emit({ type: 'log', task: 'build', stream: 'stdout', text: 'hello' })
    pending[0].resolve()
    await tick()
    await first.close()

    const second = new RunRegistry({ executor: unavailableExecutor, store: new FileRunStore(directory) })
    await second.restore()
    expect(second.get(alice, run.id)).toMatchObject({ state: 'succeeded', tasks: ['build'] })
    expect(second.get(bob, run.id)).toBeUndefined()
    const watch = second.watch(alice, run.id, 0, () => undefined)
    expect(watch?.events.map((e) => e.type)).toEqual(['state', 'state', 'log', 'state'])
  })

  it('keeps the results of the tasks over a restart', async () => {
    const { executor, pending } = manual()
    const first = new RunRegistry({ executor, store: new FileRunStore(directory) })
    const done = first.submit(alice, spec)
    await tick()
    pending[0].emit({ type: 'task', task: 'build', state: 'running' })
    pending[0].emit({ type: 'log', task: 'build', stream: 'stdout', text: 'built' })
    pending[0].emit({ type: 'task', task: 'build', state: 'succeeded', durationMs: 5 })
    pending[0].resolve()
    await tick()
    await first.close()

    const second = new RunRegistry({ executor: unavailableExecutor, store: new FileRunStore(directory) })
    await second.restore()
    expect(second.get(alice, done.id)?.results?.build).toMatchObject({
      status: 'succeeded',
      durationMs: 5,
      lastLog: ['built'],
    })
  })

  // a run as a previous start left it, waiting until `expiresAt`
  const waiting = (id: string, expiresAt: string): Run => ({
    ...prod,
    id,
    owner: alice,
    createdAt: '2026-01-01T00:00:00.000Z',
    state: 'awaiting-approval',
    approvals: [{ account: 'prod', expiresAt }],
  })

  it('lets a run that waited for an approval wait on, until its time is up', async () => {
    const now = Date.parse('2026-01-01T00:00:30Z')
    const { executor, pending } = manual()
    const store = new FileRunStore(directory)
    await store.save({ run: waiting('run_aaaaaaaaaaaaaaaa', '2026-01-01T00:01:00.000Z'), events: [] })

    const registry = new RunRegistry({ executor, store, now: () => now })
    await registry.restore()
    expect(registry.get(alice, 'run_aaaaaaaaaaaaaaaa')?.state).toBe('awaiting-approval')
    expect(registry.waiting()).toHaveLength(1)
    const result = registry.decide(
      { iss: 'https://idp.corp', sub: 'ops' },
      'run_aaaaaaaaaaaaaaaa',
      'approved',
      () => true
    )
    expect(result).toMatchObject({ status: 'ok', run: { state: 'queued' } })
    await tick()
    expect(pending).toHaveLength(1)
    await registry.close()
  })

  it('rejects a run whose time to be approved passed while the server was down', async () => {
    const store = new FileRunStore(directory)
    await store.save({ run: waiting('run_aaaaaaaaaaaaaaaa', '2026-01-01T00:01:00.000Z'), events: [] })

    const registry = new RunRegistry({
      executor: unavailableExecutor,
      store,
      now: () => Date.parse('2026-01-01T00:05:00Z'),
    })
    await registry.restore()
    expect(registry.get(alice, 'run_aaaaaaaaaaaaaaaa')).toMatchObject({
      state: 'rejected',
      error: 'nobody approved it in time',
    })
    expect(registry.waiting()).toEqual([])
  })

  it('leaves the runs that wait for an approval waiting when it is closed', async () => {
    const store = new FileRunStore(directory)
    const first = new RunRegistry({ executor: unavailableExecutor, store })
    const run = first.submit(alice, prod, ['prod'])
    await first.close()

    const second = new RunRegistry({ executor: unavailableExecutor, store })
    await second.restore()
    expect(second.get(alice, run.id)?.state).toBe('awaiting-approval')
    await second.close()
  })

  it('fails a run that was queued or running when the server stopped', async () => {
    const store = new FileRunStore(directory)
    const base = { ...spec, owner: alice, createdAt: '2026-01-01T00:00:00.000Z' }
    await store.save({ run: { ...base, id: 'run_aaaaaaaaaaaaaaaa', state: 'running' }, events: [] })
    await store.save({ run: { ...base, id: 'run_bbbbbbbbbbbbbbbb', state: 'queued' }, events: [] })

    const registry = new RunRegistry({ executor: unavailableExecutor, store })
    await registry.restore()
    for (const id of ['run_aaaaaaaaaaaaaaaa', 'run_bbbbbbbbbbbbbbbb']) {
      expect(registry.get(alice, id)).toMatchObject({
        state: 'failed',
        error: expect.stringMatching(/the server stopped while the run was (running|queued), submit it again/),
      })
    }
  })

  it('removes the record of a run that is forgotten', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor, keep: 1, store: new FileRunStore(directory) })
    const first = registry.submit(alice, spec)
    await tick()
    pending[0].resolve()
    await tick()
    const second = registry.submit(alice, spec)
    await tick()
    pending[1].resolve()
    await tick()
    await registry.close()
    expect(registry.get(alice, first.id)).toBeUndefined()
    const { records } = await new FileRunStore(directory).load()
    expect(records.map((r) => r.run.id)).toEqual([second.id])
  })
})
