import { randomBytes } from 'crypto'
import { Principal } from './oauth'
import type { RunOptions } from './run-request'

export type RunState =
  | 'awaiting-approval'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  // an approver said no, or nobody said yes in time
  | 'rejected'

const FINAL_STATES: RunState[] = ['succeeded', 'failed', 'cancelled', 'rejected']

export function isFinal(state: RunState): boolean {
  return FINAL_STATES.includes(state)
}

type Identity = { iss: string; sub: string }

// A run that was requested, not started by an admin of its account, waits for
// one admin of that account to approve it.
export interface RunApproval {
  // the run is rejected if it still waits then
  expiresAt: string
  approvedBy?: Identity
  approvedAt?: string
}

export type RunSource = { type: 'ref'; ref: string } | { type: 'upload'; snapshot: string }

export interface RunSpec {
  // the version of the published build file the run executes
  definition: { name: string; hash: string }
  // the tasks to run, by their name in the build file
  tasks: string[]
  // the service account the run uses, null for none
  account: string | null
  source: RunSource
  // the settings of `hammerkit run` the caller chose, see run-request.ts
  options: RunOptions
}

export interface Run extends RunSpec {
  id: string
  // who submitted it: only they see it
  owner: { iss: string; sub: string }
  approval?: RunApproval
  state: RunState
  createdAt: string
  startedAt?: string
  finishedAt?: string
  // why a failed run failed
  error?: string
}

// What an executor reports while it works. `seq` and `time` are added by the registry.
export type RunEventData =
  | { type: 'log'; task: string; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'task'; task: string; state: 'running' | 'succeeded' | 'failed' | 'cached' }

export type RunEvent =
  | RunEventData
  | { type: 'state'; state: RunState; error?: string }
  | { type: 'approval'; outcome: 'approved' | 'rejected'; by: Identity; reason?: string }
  | { type: 'truncated' }

export type StoredEvent = RunEvent & { seq: number; time: string }

export interface RunContext {
  emit(event: RunEventData): void
  // aborted when the run is cancelled or the server stops
  signal: AbortSignal
}

// What actually carries out a run. The registry only keeps its state; a run
// succeeds when `execute` resolves and fails when it throws.
export interface RunExecutor {
  execute(run: Run, context: RunContext): Promise<void>
}

export class RunError extends Error {}

export interface RunRegistryOptions {
  executor: RunExecutor
  // runs executing at the same time; the others wait in queue
  maxConcurrent?: number
  // finished runs that are kept, oldest dropped first
  keep?: number
  // events kept per run, a run that says more is cut off with a `truncated` event
  maxEvents?: number
  // runs that wait for an approval at the same time, and for how long (ms)
  maxWaiting?: number
  approvalTimeout?: number
  now?: () => number
}

export type DecisionResult =
  | { status: 'ok'; run: Run }
  // not a run of the caller's to see, or not on an account they are admin of
  | { status: 'not-found' }
  | { status: 'own-run' }
  | { status: 'not-waiting'; state: RunState }

interface Entry {
  run: Run
  events: StoredEvent[]
  listeners: Set<(event: StoredEvent) => void>
  abort: AbortController
  truncated: boolean
  timer?: NodeJS.Timeout
}

export const RUN_ID_PATTERN = /^run_[A-Za-z0-9_-]{16}$/

// Where runs are kept while the server is up. Everything is scoped to the
// caller that submitted the run: the same id asked for by someone else is
// "not found", so ids can't be used to find out which runs exist.
export class RunRegistry {
  private readonly entries = new Map<string, Entry>()
  private readonly queue: Entry[] = []
  private running = 0
  private closed = false
  private readonly maxConcurrent: number
  private readonly keep: number
  private readonly maxEvents: number
  private readonly maxWaiting: number
  private readonly approvalTimeout: number
  private readonly now: () => number

  constructor(private readonly options: RunRegistryOptions) {
    this.maxConcurrent = options.maxConcurrent ?? 4
    this.keep = options.keep ?? 200
    this.maxEvents = options.maxEvents ?? 5000
    this.maxWaiting = options.maxWaiting ?? 100
    this.approvalTimeout = options.approvalTimeout ?? 60 * 60 * 1000
    this.now = options.now ?? Date.now
  }

  // A run that needs an approval waits for it, the others are queued at once.
  submit(owner: Pick<Principal, 'iss' | 'sub'>, spec: RunSpec, needsApproval = false): Run {
    if (this.closed) {
      throw new RunError('the server is shutting down')
    }
    const waiting = needsApproval
    if (waiting && this.waiting().length >= this.maxWaiting) {
      throw new RunError('too many runs are waiting for an approval')
    }
    const run: Run = {
      ...spec,
      id: `run_${randomBytes(12).toString('base64url')}`,
      owner: { iss: owner.iss, sub: owner.sub },
      state: waiting ? 'awaiting-approval' : 'queued',
      createdAt: this.timestamp(),
    }
    const entry: Entry = { run, events: [], listeners: new Set(), abort: new AbortController(), truncated: false }
    this.entries.set(run.id, entry)
    this.record(entry, { type: 'state', state: run.state })
    if (waiting) {
      run.approval = {
        expiresAt: new Date(this.now() + this.approvalTimeout).toISOString(),
      }
      entry.timer = setTimeout(() => this.expire(entry), this.approvalTimeout)
      entry.timer.unref()
    } else {
      this.queue.push(entry)
    }
    this.evict()
    // what the caller is told is the run as accepted, even when it starts at once
    const accepted = this.copy(run)
    this.dispatch()
    return accepted
  }

  get(owner: Pick<Principal, 'iss' | 'sub'>, id: string): Run | undefined {
    const entry = this.find(owner, id)
    return entry ? this.copy(entry.run) : undefined
  }

  // newest first
  list(owner: Pick<Principal, 'iss' | 'sub'>): Run[] {
    return [...this.entries.values()]
      .filter((entry) => this.owns(owner, entry))
      .map((entry) => this.copy(entry.run))
      .reverse()
  }

  // A queued run is cancelled at once; a running one when its executor stops.
  cancel(owner: Pick<Principal, 'iss' | 'sub'>, id: string): Run | undefined {
    const entry = this.find(owner, id)
    if (!entry) {
      return undefined
    }
    if (entry.run.state === 'queued') {
      this.queue.splice(this.queue.indexOf(entry), 1)
      this.finish(entry, 'cancelled')
    } else if (entry.run.state === 'awaiting-approval') {
      this.finish(entry, 'cancelled')
    } else if (entry.run.state === 'running') {
      entry.abort.abort()
    }
    return this.copy(entry.run)
  }

  // The runs that wait for an approval, of anybody, oldest first. Who may see
  // them is for the caller to decide.
  waiting(): Run[] {
    return [...this.entries.values()]
      .filter((entry) => entry.run.state === 'awaiting-approval')
      .map((entry) => this.copy(entry.run))
  }

  // One run that waits (or waited), if `canDecide` says the decider is admin of
  // its account.
  getForApproval(id: string, canDecide: (account: string | null) => boolean): Run | undefined {
    const entry = this.entries.get(id)
    if (!entry || !this.mayDecide(entry, canDecide)) {
      return undefined
    }
    return this.copy(entry.run)
  }

  // An approval queues the run, a rejection ends it. Nobody decides on their own run.
  decide(
    decider: Pick<Principal, 'iss' | 'sub'>,
    id: string,
    outcome: 'approved' | 'rejected',
    canDecide: (account: string | null) => boolean,
    reason?: string
  ): DecisionResult {
    const entry = this.entries.get(id)
    if (!entry || !this.mayDecide(entry, canDecide)) {
      return { status: 'not-found' }
    }
    if (this.owns(decider, entry)) {
      return { status: 'own-run' }
    }
    if (entry.run.state !== 'awaiting-approval' || !entry.run.approval) {
      return { status: 'not-waiting', state: entry.run.state }
    }
    const by = { iss: decider.iss, sub: decider.sub }
    this.record(entry, { type: 'approval', outcome, by, ...(reason ? { reason } : {}) })
    if (outcome === 'rejected') {
      this.finish(entry, 'rejected', `rejected by ${by.sub}${reason ? `: ${reason}` : ''}`)
      return { status: 'ok', run: this.copy(entry.run) }
    }
    entry.run.approval.approvedBy = by
    entry.run.approval.approvedAt = this.timestamp()
    this.clearTimer(entry)
    entry.run.state = 'queued'
    this.record(entry, { type: 'state', state: 'queued' })
    this.queue.push(entry)
    const approved = this.copy(entry.run)
    this.dispatch()
    return { status: 'ok', run: approved }
  }

  // The events after `after` (0 for all), and a way to follow new ones. The
  // listener is not called for a run that is already over.
  watch(
    owner: Pick<Principal, 'iss' | 'sub'>,
    id: string,
    after: number,
    listener: (event: StoredEvent) => void
  ): { events: StoredEvent[]; finished: boolean; stop: () => void } | undefined {
    const entry = this.find(owner, id)
    if (!entry) {
      return undefined
    }
    const events = entry.events.filter((event) => event.seq > after)
    const finished = FINAL_STATES.includes(entry.run.state)
    if (!finished) {
      entry.listeners.add(listener)
    }
    return { events, finished, stop: () => entry.listeners.delete(listener) }
  }

  // Stops accepting runs and aborts the ones in flight.
  async close(): Promise<void> {
    this.closed = true
    for (const entry of this.queue.splice(0)) {
      this.finish(entry, 'cancelled')
    }
    for (const entry of this.entries.values()) {
      if (entry.run.state === 'awaiting-approval') {
        this.finish(entry, 'cancelled')
      }
    }
    for (const entry of this.entries.values()) {
      if (entry.run.state === 'running') {
        entry.abort.abort()
      }
    }
    while (this.running > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  private find(owner: Pick<Principal, 'iss' | 'sub'>, id: string): Entry | undefined {
    const entry = this.entries.get(id)
    return entry && this.owns(owner, entry) ? entry : undefined
  }

  private mayDecide(entry: Entry, canDecide: (account: string | null) => boolean): boolean {
    return entry.run.approval !== undefined && canDecide(entry.run.account)
  }

  private expire(entry: Entry): void {
    if (entry.run.state === 'awaiting-approval') {
      this.finish(entry, 'rejected', 'nobody approved it in time')
    }
  }

  private clearTimer(entry: Entry): void {
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
  }

  private owns(owner: Pick<Principal, 'iss' | 'sub'>, entry: Entry): boolean {
    return entry.run.owner.iss === owner.iss && entry.run.owner.sub === owner.sub
  }

  private copy(run: Run): Run {
    return {
      ...run,
      tasks: [...run.tasks],
      definition: { ...run.definition },
      source: { ...run.source },
      options: JSON.parse(JSON.stringify(run.options)),
      owner: { ...run.owner },
      ...(run.approval ? { approval: JSON.parse(JSON.stringify(run.approval)) } : {}),
    }
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString()
  }

  private dispatch(): void {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const entry = this.queue.shift() as Entry
      this.running++
      this.execute(entry).finally(() => {
        this.running--
        this.dispatch()
      })
    }
  }

  private async execute(entry: Entry): Promise<void> {
    entry.run.state = 'running'
    entry.run.startedAt = this.timestamp()
    this.record(entry, { type: 'state', state: 'running' })
    try {
      await this.options.executor.execute(this.copy(entry.run), {
        emit: (event) => this.record(entry, event),
        signal: entry.abort.signal,
      })
      this.finish(entry, entry.abort.signal.aborted ? 'cancelled' : 'succeeded')
    } catch (e) {
      this.finish(
        entry,
        entry.abort.signal.aborted ? 'cancelled' : 'failed',
        entry.abort.signal.aborted ? undefined : e instanceof Error ? e.message : String(e)
      )
    }
  }

  private finish(entry: Entry, state: RunState, error?: string): void {
    this.clearTimer(entry)
    entry.run.state = state
    entry.run.finishedAt = this.timestamp()
    if (error) {
      entry.run.error = error
    }
    this.record(entry, { type: 'state', state, ...(error ? { error } : {}) }, true)
    entry.listeners.clear()
    this.evict()
  }

  private record(entry: Entry, event: RunEvent, force = false): void {
    // an executor that keeps talking can't fill the memory of the server; the
    // state changes, which are few, are always kept
    if (!force && event.type !== 'state' && entry.events.length >= this.maxEvents) {
      if (!entry.truncated) {
        entry.truncated = true
        this.push(entry, { type: 'truncated' })
      }
      return
    }
    this.push(entry, event)
  }

  private push(entry: Entry, event: RunEvent): void {
    const stored = { ...event, seq: entry.events.length + 1, time: this.timestamp() } as StoredEvent
    entry.events.push(stored)
    for (const listener of entry.listeners) {
      listener(stored)
    }
  }

  // Only finished runs are dropped, oldest first.
  private evict(): void {
    const finished = [...this.entries.values()].filter((entry) => FINAL_STATES.includes(entry.run.state))
    for (const entry of finished.slice(0, Math.max(0, finished.length - this.keep))) {
      this.entries.delete(entry.run.id)
    }
  }
}

// Used until a backend is wired in: runs are accepted, recorded and failed with
// a reason, so the API can be used and tested without pretending to execute.
export const unavailableExecutor: RunExecutor = {
  async execute() {
    throw new Error('this server has no backend that can execute runs yet')
  },
}
