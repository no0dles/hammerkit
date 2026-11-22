import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { QuotaError, Run, RunExecutor, RunRegistry, ShuttingDownError, unavailableExecutor } from './runs'
import { FileRunStore } from './run-store'
import { readLogs } from './run-logs'

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

  it('tells a run what its tasks took in past runs of its repository', async () => {
    const contexts: { durations?: Record<string, number> }[] = []
    const executor: RunExecutor = {
      execute: (_run, context) =>
        new Promise<void>((resolve) => {
          contexts.push(context)
          const emit = context.emit
          if (contexts.length <= 3) {
            // build ran 10, 30, 20 s by its commands, though it waited before; lint failed
            const ran = [10, 30, 20][contexts.length - 1]
            emit({
              type: 'task',
              task: 'build',
              state: 'succeeded',
              durationMs: ran * 1000 + 99_000,
              commands: [
                { startedAt: '2026-11-14T12:00:00.000Z', finishedAt: '2026-11-14T12:00:01.000Z' },
                {
                  startedAt: '2026-11-14T12:00:02.000Z',
                  finishedAt: new Date(Date.UTC(2026, 10, 14, 12, 0, ran)).toISOString(),
                },
              ],
            })
            emit({ type: 'task', task: 'lint', state: 'failed', durationMs: 5000 })
            emit({ type: 'task', task: 'test', state: 'succeeded', durationMs: 7000 })
          }
          resolve()
        }),
    }
    const registry = new RunRegistry({ executor })
    for (let i = 0; i < 3; i++) {
      registry.submit(alice, { ...spec, tasks: ['build', 'lint', 'test'] })
      await tick()
    }
    registry.submit(bob, { ...spec, tasks: ['build'] })
    // another repository knows nothing of them
    registry.submit(alice, { ...spec, source: { ...spec.source, repo: 'github.com/corp/other' } })
    await tick()
    expect(contexts[0].durations).toBeUndefined()
    expect(contexts[3].durations).toEqual({ build: 20_000, test: 7000 })
    expect(contexts[4].durations).toBeUndefined()
  })

  it('keeps the first check key a task reported, and hands the keys to onFinished only', async () => {
    const { executor, pending } = manual()
    const finished: Record<string, string | null>[] = []
    const registry = new RunRegistry({ executor, onFinished: (_run, keys) => finished.push(keys) })
    const run = registry.submit(alice, spec)
    await tick()
    pending[0].emit({ type: 'key', task: 'build', key: 'a'.repeat(64) })
    // a later key, after the task wrote to its files, is not the one of the files it started from
    pending[0].emit({ type: 'key', task: 'build', key: 'b'.repeat(64) })
    pending[0].emit({ type: 'key', task: 'lint', key: null })
    pending[0].resolve()
    await tick()
    expect(finished).toEqual([{ build: 'a'.repeat(64), lint: null }])
    // keys are not events anybody watching the run sees
    expect(registry.watch(alice, run.id, 0, () => undefined)?.events.map((e) => e.type)).not.toContain('key')
  })

  it('keeps the phases of a run in their order, the newest of each, and not as events', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, spec)
    await tick()
    const at = (second: number) => new Date(Date.UTC(2026, 10, 14, 12, 0, second)).toISOString()
    pending[0].emit({ type: 'phase', phase: 'plan', startedAt: at(3), finishedAt: at(4) })
    pending[0].emit({ type: 'phase', phase: 'source', startedAt: at(0), finishedAt: at(1) })
    pending[0].emit({ type: 'phase', phase: 'source', startedAt: at(1), finishedAt: at(2) })
    // what is not a phase, or ends before it starts, is dropped
    pending[0].emit({ type: 'phase', phase: 'other' as 'plan', startedAt: at(0), finishedAt: at(1) })
    pending[0].emit({ type: 'phase', phase: 'namespace', startedAt: at(2), finishedAt: at(1) })
    pending[0].emit({ type: 'phase', phase: 'namespace', startedAt: 'soon', finishedAt: at(1) })
    pending[0].resolve()
    await tick()
    expect(registry.get(alice, run.id)?.phases).toEqual([
      { phase: 'source', startedAt: at(1), finishedAt: at(2) },
      { phase: 'plan', startedAt: at(3), finishedAt: at(4) },
    ])
    expect(registry.watch(alice, run.id, 0, () => undefined)?.events.map((e) => e.type)).not.toContain('phase')
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
    // which a client may send again: the server took nothing of it
    expect(() => registry.submit(alice, spec)).toThrow(ShuttingDownError)
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

  it('keeps a run queued, without a timer, while a run that holds the same executes', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({
      // what the backend holds: here, one run of a caller at a time
      executor: { ...executor, excludes: (run, other) => run.owner.sub === other.owner.sub },
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

describe('RunRegistry sandboxes', () => {
  const on = (id: string) => ({
    ...spec,
    source: { type: 'sandbox' as const, id, repo: 'github.com/corp/payments', commit: 'c'.repeat(40), tree: 't' },
  })

  it('runs one run at a time on a sandbox, and others next to it', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor, maxConcurrent: 4 })
    const first = registry.submit(alice, on('sbx_aaaaaaaaaaaaaaaa'))
    const second = registry.submit(alice, on('sbx_aaaaaaaaaaaaaaaa'))
    const other = registry.submit(alice, on('sbx_bbbbbbbbbbbbbbbb'))
    await tick()
    expect(pending).toHaveLength(2)
    expect(registry.get(alice, second.id)?.state).toBe('queued')
    expect(registry.get(alice, other.id)?.state).toBe('running')
    pending[0].resolve()
    await tick()
    expect(registry.get(alice, first.id)?.state).toBe('succeeded')
    expect(registry.get(alice, second.id)?.state).toBe('running')
    await registry.close()
  })

  it('names the run that holds a sandbox, from its submit until it is over', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor, maxConcurrent: 1 })
    registry.submit(alice, spec)
    const waiting = registry.submit(alice, on('sbx_aaaaaaaaaaaaaaaa'))
    await tick()
    expect(registry.get(alice, waiting.id)?.state).toBe('queued')
    expect(registry.holder('sbx_aaaaaaaaaaaaaaaa')).toBe(waiting.id)
    expect(registry.holder('sbx_bbbbbbbbbbbbbbbb')).toBeUndefined()
    pending[0].resolve()
    await tick()
    pending[1].resolve()
    await tick()
    expect(registry.holder('sbx_aaaaaaaaaaaaaaaa')).toBeUndefined()
    await registry.close()
  })

  it('stops every run on a sandbox and waits for the running one', async () => {
    const { executor } = manual()
    const registry = new RunRegistry({ executor })
    const running = registry.submit(alice, on('sbx_aaaaaaaaaaaaaaaa'))
    const queued = registry.submit(alice, on('sbx_aaaaaaaaaaaaaaaa'))
    const waiting = registry.submit(alice, { ...on('sbx_aaaaaaaaaaaaaaaa'), accounts: ['prod'] }, ['prod'])
    const other = registry.submit(alice, on('sbx_bbbbbbbbbbbbbbbb'))
    await tick()
    await registry.stopSandbox('sbx_aaaaaaaaaaaaaaaa', 'the sandbox was deleted')
    expect(registry.get(alice, running.id)?.state).toBe('cancelled')
    expect(registry.get(alice, queued.id)).toMatchObject({ state: 'cancelled', error: 'the sandbox was deleted' })
    expect(registry.get(alice, waiting.id)?.state).toBe('cancelled')
    expect(registry.get(alice, other.id)?.state).toBe('running')
    await registry.close()
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

  it('keeps when the commands of a task ran, at most 50 well-formed ones', async () => {
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor })
    const run = registry.submit(alice, { ...spec, tasks: ['build', 'test'] })
    await tick()
    const command = { startedAt: '2026-11-14T10:00:05.000Z', finishedAt: '2026-11-14T10:00:30.000Z' }
    pending[0].emit({ type: 'task', task: 'build', state: 'running' })
    pending[0].emit({
      type: 'task',
      task: 'build',
      state: 'succeeded',
      durationMs: 40_000,
      commands: [command, { startedAt: 'not a date', finishedAt: command.finishedAt }],
    })
    pending[0].emit({
      type: 'task',
      task: 'test',
      state: 'failed',
      exitCode: 1,
      commands: Array.from({ length: 80 }, () => ({ ...command, extra: 'x'.repeat(1000) })),
    })
    pending[0].reject(new Error('test failed'))
    await tick()

    const results = registry.get(alice, run.id)?.results
    expect(results?.build.commands).toEqual([command])
    expect(results?.test.commands).toHaveLength(50)
    expect(results?.test.commands?.[0]).toEqual(command)
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

  it('fails a run that was queued or running when the server stopped, if its record can not resume it', async () => {
    const store = new FileRunStore(directory)
    const base = { ...spec, owner: alice, createdAt: '2026-01-01T00:00:00.000Z' }
    await store.save({
      run: { ...base, tasks: undefined, id: 'run_aaaaaaaaaaaaaaaa', state: 'running' } as unknown as Run,
      events: [],
    })
    await store.save({
      run: { ...base, source: undefined, id: 'run_bbbbbbbbbbbbbbbb', state: 'queued' } as unknown as Run,
      events: [],
    })
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor, store })
    await registry.restore()
    await tick()
    expect(registry.get(alice, 'run_aaaaaaaaaaaaaaaa')).toMatchObject({
      state: 'failed',
      error:
        'the server stopped while the run was running and its record can not resume it: it names no tasks, submit it again',
    })
    expect(registry.get(alice, 'run_bbbbbbbbbbbbbbbb')).toMatchObject({
      state: 'failed',
      error:
        'the server stopped while the run was queued and its record can not resume it: it names no source, submit it again',
    })
    expect(pending).toHaveLength(0)
  })

  describe('over a restart', () => {
    const resumed = { type: 'log', task: 'hammerkit', stream: 'stdout', text: 'resumed after a server restart' }

    it('tells the backend which runs resume, and has it remove what one left when it is cancelled before it executes again', async () => {
      const store = new FileRunStore(directory)
      const base = {
        ...spec,
        owner: alice,
        createdAt: '2026-01-01T00:00:00.000Z',
        startedAt: '2026-01-01T00:00:01.000Z',
      }
      await store.save({ run: { ...base, id: 'run_aaaaaaaaaaaaaaaa', state: 'running' }, events: [] })
      await store.save({ run: { ...base, id: 'run_bbbbbbbbbbbbbbbb', state: 'running' }, events: [] })
      const { executor, pending } = manual()
      const restored: string[][] = []
      const forgotten: string[] = []
      const registry = new RunRegistry({
        executor: {
          ...executor,
          restored: (runs) => restored.push(runs.map((run) => `${run.id} ${run.state}`)),
          forget: async (run) => {
            forgotten.push(run.id)
          },
        },
        maxConcurrent: 1,
        store,
      })
      await registry.restore()
      await tick()
      expect(restored).toEqual([['run_aaaaaaaaaaaaaaaa queued', 'run_bbbbbbbbbbbbbbbb queued']])
      expect(pending).toHaveLength(1)
      // no execution holds what the second one left on the cluster
      expect(registry.cancel(alice, 'run_bbbbbbbbbbbbbbbb')?.state).toBe('cancelled')
      await tick()
      expect(forgotten).toEqual(['run_bbbbbbbbbbbbbbbb'])
      await registry.close()
    })

    it('detaches the running runs when it is closed: they are not cancelled, and their record has all of their log', async () => {
      const store = new FileRunStore(directory)
      const executor = {
        detached: [] as (boolean | undefined)[],
        pending: [] as { emit: (e: any) => void }[],
        execute(_run: Run, context: Parameters<RunExecutor['execute']>[1]) {
          return new Promise<void>((_resolve, reject) => {
            this.pending.push({ emit: context.emit })
            context.signal.addEventListener('abort', () => {
              this.detached.push(context.detached?.())
              reject(new Error('the run was cancelled'))
            })
          })
        },
      }
      const registry = new RunRegistry({ executor, maxConcurrent: 1, store })
      const running = registry.submit(alice, spec)
      const queued = registry.submit(alice, spec)
      await tick()
      executor.pending[0].emit({ type: 'task', task: 'build', state: 'running' })
      executor.pending[0].emit({ type: 'log', task: 'build', stream: 'stdout', text: 'half way' })
      await registry.close()
      expect(executor.detached).toEqual([true])
      expect(registry.get(alice, running.id)?.state).toBe('running')
      expect(registry.get(alice, queued.id)?.state).toBe('queued')
      const { records } = await store.load()
      const record = records.find((r) => r.run.id === running.id)
      expect(record?.run.state).toBe('running')
      expect(record?.events.map((e) => e.type)).toEqual(['state', 'state', 'task', 'log'])
      expect(records.find((r) => r.run.id === queued.id)?.run.state).toBe('queued')
    })

    it('keeps the check keys a run reported before the restart', async () => {
      const store = new FileRunStore(directory)
      const first = manual()
      const before = new RunRegistry({ executor: first.executor, store })
      const run = before.submit(alice, spec)
      await tick()
      first.pending[0].emit({ type: 'key', task: 'build', key: 'a'.repeat(64) })
      await before.close()
      const finished: Record<string, string | null>[] = []
      const second = manual()
      const after = new RunRegistry({
        executor: second.executor,
        store,
        onFinished: (_run, keys) => finished.push(keys),
      })
      await after.restore()
      await tick()
      // the one computed before anything ran, not one of the execution after the restart
      second.pending[0].emit({ type: 'key', task: 'build', key: 'b'.repeat(64) })
      second.pending[0].resolve()
      await tick()
      expect(after.get(alice, run.id)?.state).toBe('succeeded')
      expect(finished).toEqual([{ build: 'a'.repeat(64) }])
    })

    describe('where the logs of its pods got to', () => {
      // an executor that keeps what each execution was told
      function told() {
        const contexts: Parameters<RunExecutor['execute']>[1][] = []
        const executor: RunExecutor = {
          execute: (_run, context) =>
            new Promise<void>((_resolve, reject) => {
              contexts.push(context)
              context.signal.addEventListener('abort', () => reject(new Error('aborted')))
            }),
        }
        return { executor, contexts }
      }
      const cursor = (count: number) => ({ container: 'containerd://abc', at: '2026-11-22T10:00:00.000000000', count })
      const line = (text: string, count: number) => ({
        type: 'log',
        task: 'build',
        stream: 'stdout',
        text,
        cursor: cursor(count),
      })

      it('hands the execution of a resumed run where the log of each task got to, and keeps it out of the events', async () => {
        const store = new FileRunStore(directory)
        const first = told()
        const before = new RunRegistry({ executor: first.executor, store })
        const run = before.submit(alice, spec)
        await tick()
        // a fresh run takes over nothing
        expect(first.contexts[0].resumed).toBeUndefined()
        first.contexts[0].emit(line('one', 1) as any)
        first.contexts[0].emit(line('two', 2) as any)
        await before.close()

        const second = told()
        const after = new RunRegistry({ executor: second.executor, store })
        await after.restore()
        await tick()
        expect(second.contexts[0].resumed).toEqual({ logs: { build: cursor(2) } })
        const logs = (after.logs(alice, run.id)?.events ?? []).filter((e) => e.type === 'log' && e.task === 'build')
        expect(logs.map((e) => (e as any).text)).toEqual(['one', 'two'])
        expect(logs.some((e) => 'cursor' in e)).toBe(false)
        await after.close()
      })

      it('after a server that was killed, is where the log it kept got to: the lines it lost are read again', async () => {
        const store = new FileRunStore(directory)
        let killed = false
        const first = told()
        const before = new RunRegistry({
          executor: first.executor,
          store: {
            ...store,
            load: () => store.load(),
            remove: (id) => store.remove(id),
            save: (r) => (killed ? Promise.resolve() : store.save(r)),
          },
          persistEvery: 20,
        })
        const run = before.submit(alice, spec)
        await tick()
        first.contexts[0].emit(line('one', 1) as any)
        await new Promise((resolve) => setTimeout(resolve, 60))
        // said after the record was last written, and lost with the server
        killed = true
        first.contexts[0].emit(line('two', 2) as any)
        await before.close()

        const second = told()
        const after = new RunRegistry({ executor: second.executor, store })
        await after.restore()
        await tick()
        expect(after.get(alice, run.id)?.lostAfter).toBeDefined()
        expect(second.contexts[0].resumed).toEqual({ logs: { build: cursor(1) } })
        await after.close()
      })
    })

    it('fails a service run whose record names no services, and one of nobody', async () => {
      const store = new FileRunStore(directory)
      const base = {
        ...spec,
        owner: alice,
        createdAt: '2026-01-01T00:00:00.000Z',
        startedAt: '2026-01-01T00:00:01.000Z',
      }
      await store.save({
        run: { ...base, id: 'run_aaaaaaaaaaaaaaaa', state: 'up', up: { name: 'web', services: 'web' } } as any,
        events: [],
      })
      await store.save({
        run: { ...base, id: 'run_bbbbbbbbbbbbbbbb', state: 'running', owner: { sub: 1 } } as any,
        events: [],
      })
      const { executor, pending } = manual()
      const restored: string[][] = []
      const registry = new RunRegistry({
        executor: { ...executor, restored: (runs) => restored.push(runs.map((r) => r.id)) },
        store,
      })
      await registry.restore()
      await tick()
      expect(registry.get(alice, 'run_aaaaaaaaaaaaaaaa')).toMatchObject({
        state: 'failed',
        error:
          'the server stopped while the run was up and its record can not resume it: it names no services, submit it again',
      })
      expect(registry.peek('run_bbbbbbbbbbbbbbbb')).toMatchObject({
        state: 'failed',
        owner: { iss: '', sub: '' },
        error: expect.stringContaining('it names no owner'),
      })
      expect(registry.list(alice).map((r) => r.id)).toEqual(['run_aaaaaaaaaaaaaaaa'])
      expect(restored).toEqual([[]])
      expect(pending).toHaveLength(0)
    })

    it('writes the runs down and returns when an execution does not stop in time', async () => {
      const store = new FileRunStore(directory)
      const emits: ((e: any) => void)[] = []
      // hears the abort, and goes on
      const executor: RunExecutor = {
        execute: (_run, context) => new Promise<void>(() => emits.push(context.emit)),
      }
      const lines: string[] = []
      const registry = new RunRegistry({ executor, store, closeTimeout: 50, log: (line) => lines.push(line) })
      const run = registry.submit(alice, spec)
      await tick()
      emits[0]({ type: 'log', task: 'build', stream: 'stdout', text: 'still going' })
      const closing = Date.now()
      await registry.close()
      expect(Date.now() - closing).toBeLessThan(2000)
      expect(lines).toEqual(['the server stops while 1 run still stops, it is written down as it is'])
      const { records } = await store.load()
      expect(records.find((r) => r.run.id === run.id)?.events.map((e) => e.type)).toEqual(['state', 'state', 'log'])
    })

    it('writes the record of a running run down every so often, so a server that is killed loses little of its log', async () => {
      class CountingStore extends FileRunStore {
        saves = 0
        save(record: Parameters<FileRunStore['save']>[0]) {
          this.saves++
          return super.save(record)
        }
      }
      const store = new CountingStore(directory)
      const { executor, pending } = manual()
      const registry = new RunRegistry({ executor, store, persistEvery: 30 })
      const run = registry.submit(alice, spec)
      await tick()
      const logged = async () =>
        (await store.load()).records[0].events.flatMap((e) => (e.type === 'log' ? [e.text] : []))
      const saves = store.saves
      pending[0].emit({ type: 'log', task: 'build', stream: 'stdout', text: 'one' })
      pending[0].emit({ type: 'log', task: 'build', stream: 'stdout', text: 'two' })
      // not on every line
      expect(store.saves).toBe(saves)
      await vi.waitFor(async () => expect(await logged()).toEqual(['one', 'two']))
      pending[0].emit({ type: 'log', task: 'build', stream: 'stdout', text: 'three' })
      await vi.waitFor(async () => expect(await logged()).toEqual(['one', 'two', 'three']))
      expect(store.saves).toBe(saves + 2)
      expect(registry.get(alice, run.id)?.state).toBe('running')
      await registry.close()
    })

    it('ends a run cancelled while the server stopped, and does not resume it', async () => {
      const store = new FileRunStore(directory)
      // hears the abort of the server, and goes on until it is killed
      const executor: RunExecutor = { execute: () => new Promise<void>(() => undefined) }
      const before = new RunRegistry({ executor, store, closeTimeout: 50 })
      const run = before.submit(alice, spec)
      await tick()
      const closing = before.close()
      // the run is detached already, the cancel still counts
      expect(before.cancel(alice, run.id)?.state).toBe('running')
      await closing
      const forgotten: string[] = []
      const { executor: next, pending } = manual()
      const after = new RunRegistry({
        executor: { ...next, forget: async (r) => void forgotten.push(r.id) },
        store,
      })
      await after.restore()
      await tick()
      expect(after.get(alice, run.id)?.state).toBe('cancelled')
      expect(after.get(alice, run.id)?.cancelling).toBeUndefined()
      expect(pending).toHaveLength(0)
      await vi.waitFor(() => expect(forgotten).toEqual([run.id]))
    })

    it('gives a resumed run what was left of its time, and fails one whose time ran out while the server was down', async () => {
      const store = new FileRunStore(directory)
      let now = Date.parse('2026-01-01T00:00:00Z')
      const first = manual()
      const before = new RunRegistry({ executor: first.executor, store, maxDuration: 300, now: () => now })
      const short = before.submit(alice, spec)
      const long = before.submit(alice, spec)
      await tick()
      const startedAt = before.get(alice, short.id)?.startedAt
      await before.close()
      // `long` waited longer for a server than it may run
      const records = await store.load()
      const waited = records.records.find((r) => r.run.id === long.id) as any
      await store.save({ ...waited, run: { ...waited.run, startedAt: '2025-12-31T23:59:00.000Z' } })

      now += 200
      const second = manual()
      const after = new RunRegistry({ executor: second.executor, store, maxDuration: 300, now: () => now })
      await after.restore()
      expect(after.get(alice, long.id)).toMatchObject({
        state: 'failed',
        error: 'the run took longer than 300ms and was stopped',
      })
      await tick()
      // its time counts from its first start, it has 100ms left
      expect(after.get(alice, short.id)).toMatchObject({ state: 'running', startedAt })
      await vi.waitFor(() =>
        expect(after.get(alice, short.id)).toMatchObject({
          state: 'failed',
          error: 'the run took longer than 300ms and was stopped',
        })
      )
    })

    it('fails a run the server stopped with too often in a row, and counts again once it got somewhere', async () => {
      const store = new FileRunStore(directory)
      const base = {
        ...spec,
        owner: alice,
        createdAt: '2026-01-01T00:00:00.000Z',
        startedAt: '2026-01-01T00:00:01.000Z',
      }
      await store.save({ run: { ...base, id: 'run_aaaaaaaaaaaaaaaa', state: 'running', resumes: 3 }, events: [] })
      await store.save({ run: { ...base, id: 'run_bbbbbbbbbbbbbbbb', state: 'running', resumes: 2 }, events: [] })
      const { executor, pending } = manual()
      const registry = new RunRegistry({ executor, store })
      await registry.restore()
      await tick()
      expect(registry.get(alice, 'run_aaaaaaaaaaaaaaaa')).toMatchObject({
        state: 'failed',
        error:
          'the server stopped 4 times in a row while the run was running, it is not resumed again, submit it again',
      })
      expect(registry.get(alice, 'run_bbbbbbbbbbbbbbbb')).toMatchObject({ state: 'running', resumes: 3 })
      pending[0].emit({ type: 'task', task: 'build', state: 'running' })
      expect(registry.get(alice, 'run_bbbbbbbbbbbbbbbb')?.resumes).toBe(3)
      pending[0].emit({ type: 'task', task: 'build', state: 'succeeded' })
      expect(registry.get(alice, 'run_bbbbbbbbbbbbbbbb')?.resumes).toBeUndefined()
      await registry.close()
    })

    it('tells the clients of a run a killed server lost what it said last, and where it went on', async () => {
      const store = new FileRunStore(directory)
      const first = manual()
      // writes down the state changes only, here
      const before = new RunRegistry({ executor: first.executor, store, persistEvery: 60_000 })
      const run = before.submit(alice, spec)
      await tick()
      first.pending[0].emit({ type: 'log', task: 'build', stream: 'stdout', text: 'seen\nby the client' })
      const seen = before.watch(alice, run.id, 0, () => undefined)?.events ?? []
      expect(seen.map((e) => e.seq)).toEqual([1, 2, 3])
      // killed: no close, the record is the one of the last state change

      const second = manual()
      const after = new RunRegistry({ executor: second.executor, store })
      await after.restore()
      await tick()
      expect(after.get(alice, run.id)).toMatchObject({ state: 'running', lostAfter: 2 })
      // a client past the end gets what was said again since, from where it went on; one whose
      // cursor is not past it any more compares it with lostAfter
      expect(after.watch(alice, run.id, 10, () => undefined)?.events).toMatchObject([
        { seq: 3, type: 'log', text: 'resumed after a server restart, the last of its log before is lost' },
        { seq: 4, type: 'state', state: 'queued' },
        { seq: 5, type: 'state', state: 'running' },
      ])
      const log = after.logs(alice, run.id)
      const page = (from: number) =>
        readLogs(log!.events, log!.index, { from, limit: 100, ignoreCase: false, context: 0 }, false, log!.lostAfter)
      // the client read two lines, which are gone: line 1 is where the log went on
      expect(page(3)).toMatchObject({ lost: 1, lines: [] })
      expect(page(1).lines.map((l) => l.text)).toEqual([
        'resumed after a server restart, the last of its log before is lost',
      ])
      await after.close()
      await before.close()
    })

    it('resumes the runs that were running or queued under their id, and the cursors of their clients stay valid', async () => {
      const store = new FileRunStore(directory)
      const first = manual()
      const before = new RunRegistry({ executor: first.executor, maxConcurrent: 1, store })
      const planned = { ...spec, plan: { build: { kind: 'task', runtime: 'docker' } } as any }
      const running = before.submit(alice, planned)
      const queued = before.submit(alice, spec)
      await tick()
      first.pending[0].emit({ type: 'task', task: 'build', state: 'running' })
      first.pending[0].emit({ type: 'log', task: 'build', stream: 'stdout', text: 'half way' })
      const seen = before.watch(alice, running.id, 0, () => undefined)?.events ?? []
      const cursor = seen[seen.length - 1].seq
      await before.close()

      const second = manual()
      const seenRuns: Run[] = []
      const after = new RunRegistry({
        executor: {
          execute: (run, context) => {
            seenRuns.push(run)
            return second.executor.execute(run, context)
          },
        },
        maxConcurrent: 1,
        store,
      })
      await after.restore()
      await tick()
      expect(seenRuns.map((run) => run.id)).toEqual([running.id])
      expect(seenRuns[0]).toMatchObject({ source: spec.source, plan: planned.plan, tasks: ['build'] })
      expect(after.get(alice, running.id)?.state).toBe('running')
      expect(after.get(alice, queued.id)?.state).toBe('queued')
      // a client that read up to its cursor reads on from there
      const since = after.watch(alice, running.id, cursor, () => undefined)?.events ?? []
      expect(since).toMatchObject([resumed, { type: 'state', state: 'queued' }, { type: 'state', state: 'running' }])
      expect(since[0].seq).toBe(cursor + 1)
      // the server that stopped wrote all of it down: nothing was lost
      expect(after.get(alice, running.id)?.lostAfter).toBeUndefined()
      const lines = after.logs(alice, running.id)
      expect(lines?.events.slice(0, seen.length)).toEqual(seen)
      second.pending[0].emit({ type: 'task', task: 'build', state: 'cached' })
      second.pending[0].resolve()
      await tick()
      expect(after.get(alice, running.id)?.state).toBe('succeeded')
      expect(seenRuns.map((run) => run.id)).toEqual([running.id, queued.id])
      second.pending[1].resolve()
      await tick()
      expect(after.get(alice, queued.id)?.state).toBe('succeeded')
      expect(after.watch(alice, queued.id, 0, () => undefined)?.events.map((e) => e.type)).toEqual([
        'state',
        'log',
        'state',
        'state',
        'state',
      ])
    })
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

  it('waits on close until the record of a forgotten run is removed', async () => {
    // a slow disk: the removal finishes well after the run was evicted
    class SlowRemoveStore extends FileRunStore {
      async remove(id: string): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 200))
        await super.remove(id)
      }
    }
    const { executor, pending } = manual()
    const registry = new RunRegistry({ executor, keep: 1, store: new SlowRemoveStore(directory) })
    const first = registry.submit(alice, spec)
    await tick()
    pending[0].resolve()
    await tick()
    const second = registry.submit(alice, spec)
    await tick()
    pending[1].resolve()
    await tick()
    await registry.close()
    const { records } = await new FileRunStore(directory).load()
    expect(records.map((r) => r.run.id)).toEqual([second.id])
    expect(records.map((r) => r.run.id)).not.toContain(first.id)
  })
})
