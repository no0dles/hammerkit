import { randomBytes } from 'crypto'
import { Principal } from './oauth'
import type { RunOptions } from './run-request'
import type { TaskPlan } from './plan'
import type { RunStore } from './run-store'
import { LogIndex } from './run-logs'
import { formatDuration } from '../utils/units'

export type RunState =
  | 'awaiting-approval'
  | 'queued'
  | 'running'
  // the services of a service run are ready, and stay until its ttl ends or it is stopped
  | 'up'
  // a service run whose services stopped after its sleepTtl without a request: the next
  // request to one of its endpoints starts them again, until its ttl ends
  | 'asleep'
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

// A run that uses accounts its owner may only request waits for somebody who may
// use each of them. One entry per account, one expiry for the run: it is
// rejected if it still waits then. An approver covers every account they use, so
// one person is enough when they use all of them.
export interface RunApproval {
  account: string
  expiresAt: string
  approvedBy?: Identity
  approvedAt?: string
}

// A ref run names a repository (`host/path`) and a branch, tag or commit of it, and is
// pinned to the commit the ref pointed to when it was submitted, so what is approved is
// what runs.
//
// A sandbox run names a sandbox of its owner. What it started from is recorded when it was
// submitted: the commit the sandbox was fetched at and the git tree of its files, which
// together name the changes it held, and whether it held any. A run that waited for an
// approval fails when the files are no longer the ones that were approved.
export type RunSource =
  | { type: 'ref'; repo: string; ref: string; commit: string }
  | { type: 'upload'; snapshot: string }
  // `check`: the run works on a copy of the files `tree` names, not on the sandbox, so
  // what it passes counts for any commit with the same files (see checks.ts)
  | { type: 'sandbox'; id: string; repo: string; commit: string; tree: string; clean?: boolean; check?: true }

export interface RunSpec {
  // the hash of the published version of the build file the run executes
  definition: string
  // the tasks to run, by their name in the build file
  tasks: string[]
  // the accounts the run uses: the ones its secrets are read as, derived from the
  // published build file and never requested
  accounts: string[]
  // what the tasks and services of the run do, with their dependencies, for who
  // decides about it; read from the pinned files when the run was submitted
  plan?: Record<string, TaskPlan>
  source: RunSource
  // the settings of `hammerkit run` the caller chose, see run-request.ts
  options: RunOptions
  // a service run: the services it starts instead of tasks, see ServiceRunSpec
  up?: ServiceRunSpec
}

// What a service run keeps up, and for how long.
export interface ServiceRunSpec {
  services: string[]
  // how long the services stay once ready (ms), whether they sleep in between or not
  ttl: number
  // how long the services stay up without a request to an endpoint before they sleep (ms)
  sleepTtl?: number
  // a later service run of the same caller with this name replaces it
  name: string
  // the ports published at hosts of their own
  endpoints: RunEndpoint[]
}

export interface RunEndpoint {
  service: string
  port: number
  // the label of its host below the endpoints domain, and the address it is opened at
  host: string
  url: string
}

// Where the server reaches the port of an endpoint, once its service is up.
export interface EndpointTarget {
  service: string
  port: number
  address: { host: string; port: number }
}

// How a task of a run went, or goes. `skipped` is a dependency no task of the run needed,
// because every task that depends on it was taken from the cache; `cancelled` did not
// finish because the run was stopped or another task failed.
export type TaskStatus = 'running' | 'succeeded' | 'failed' | 'cached' | 'skipped' | 'cancelled'

// What a client needs to know about one task without reading the log: an agent reads
// this first and only asks for more of the log when it has to.
export interface TaskResult {
  status: TaskStatus
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  // of the command that failed
  exitCode?: number
  // why it failed when there is no exit code, a timeout for example
  error?: string
  // whether it was taken from the cache, and if not, why it ran (as `--explain` says it)
  cache?: { hit: boolean; causes?: string[] }
  // the last lines the task printed, stdout and stderr as they came, the newest last. They
  // are kept even when the log of the run was cut off, so the error is always there.
  lastLog: string[]
}

export interface Run extends RunSpec {
  id: string
  // who submitted it: only they see it. A run that may sleep keeps the groups and claims
  // its owner was entitled by, so a wake checks the owner's rights of the moment.
  owner: { iss: string; sub: string; groups?: string[]; claims?: Record<string, string> }
  approvals?: RunApproval[]
  state: RunState
  createdAt: string
  startedAt?: string
  finishedAt?: string
  // why a failed run failed
  error?: string
  // per task, by its name, from the moment it starts
  results?: Record<string, TaskResult>
  // a service run: when its services were ready, and when they stop
  upAt?: string
  expiresAt?: string
  // a service run with a sleepTtl: when its services sleep without a request, how often
  // a request woke them
  sleepsAt?: string
  wakes?: number
  // a service run that was up: why it stopped, `ttl`, `replaced` by one of the same name,
  // or who cancelled it
  stoppedBy?: 'ttl' | 'replaced' | Identity
}

// What an executor reports while it works. `seq` and `time` are added by the registry.
export type RunEventData =
  | { type: 'log'; task: string; stream: 'stdout' | 'stderr'; text: string }
  // the check key of a task (check-key.ts), before anything ran; null when its result says
  // nothing about its files. Kept by the registry, not shown in the events.
  | { type: 'key'; task: string; key: string | null }
  | {
      type: 'task'
      task: string
      state: TaskStatus
      // once the task is over
      durationMs?: number
      exitCode?: number
      error?: string
      // why a task that ran was not taken from the cache
      causes?: string[]
    }

export type RunEvent =
  | RunEventData
  | { type: 'state'; state: RunState; error?: string }
  | { type: 'approval'; outcome: 'approved' | 'rejected'; by: Identity; accounts: string[]; reason?: string }
  | { type: 'extended'; by: Identity; expiresAt: string }
  | { type: 'truncated' }

export type StoredEvent = RunEvent & { seq: number; time: string }

export interface RunContext {
  emit(event: RunEventData): void
  // aborted when the run is cancelled or the server stops, or a service run's ttl ended
  signal: AbortSignal
  // a service run: its services are ready, the endpoints are reached at these addresses.
  // The executor keeps them up until `signal` aborts.
  up?(targets: EndpointTarget[]): void
}

// What actually carries out a run. The registry only keeps its state; a run
// succeeds when `execute` resolves and fails when it throws.
export interface RunExecutor {
  execute(run: Run, context: RunContext): Promise<void>
  // what a run holds while it executes, if anything: two runs that hold the same execute
  // one after the other, the second waits in the queue
  exclusive?(run: Run): string | undefined
}

// The server can not take the run now; `status` is what the caller is told
export class RunError extends Error {
  status: number = 503
}

// A caller is over one of their limits, others may still submit
export class QuotaError extends RunError {
  status = 429
}

// What one caller may have at a time
export interface RunLimits {
  // runs that wait for an approval
  waiting: number
  // runs that wait in the queue for a free place
  queued: number
  // runs that execute at the same time; the others of the caller wait in the queue
  running: number
}

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
  // what one caller may have waiting, queued and running; unlimited when left out
  limits?: RunLimits
  // a run that executes longer is stopped and fails (ms)
  maxDuration?: number
  // log output kept per run (bytes of text), the rest is cut off with a `truncated` event
  maxLogBytes?: number
  // service runs: how long they stay at most (ms) from a start or an extend, and how many
  // one caller and the whole server have starting or up
  up?: { maxTtl: number; perCaller: number; total: number }
  // keeps the runs over a restart
  store?: RunStore
  // told of every run that ended, with the check keys its executor reported per task
  onFinished?: (run: Run, keys: Record<string, string | null>) => void
  log?: (line: string) => void
  now?: () => number
}

export type DecisionResult =
  | { status: 'ok'; run: Run }
  // not a run of the caller's to see, or none of the accounts waiting for an approval is one they use
  | { status: 'not-found' }
  | { status: 'own-run' }
  | { status: 'not-waiting'; state: RunState }
  // an approval of accounts that are all approved already: the run waits for others
  | { status: 'already-approved' }

interface Entry {
  run: Run
  events: StoredEvent[]
  listeners: Set<(event: StoredEvent) => void>
  abort: AbortController
  truncated: boolean
  bytes: number
  // the last lines of each task, kept apart from the capped log
  tails: Map<string, string[]>
  // where the lines of the log are, made when the log is first read
  index?: LogIndex
  timer?: NodeJS.Timeout
  // the run was stopped because it took too long
  timedOut?: boolean
  // writes of the record one after the other
  saving: Promise<void>
  // the stop of a run that takes too long, until a service run is up
  durationTimer?: NodeJS.Timeout
  // a service run that is up gave its place of maxConcurrent back
  released?: boolean
  // where the endpoints of a service run that is up are reached
  targets?: EndpointTarget[]
  // the services of a service run are stopped to sleep, not for good
  sleeping?: boolean
  // the check keys the executor reported, by task
  keys: Record<string, string | null>
}

type AccountCheck = (account: string) => boolean

export const RUN_ID_PATTERN = /^run_[A-Za-z0-9_-]{16}$/
export const SANDBOX_ID_PATTERN = /^sbx_[A-Za-z0-9_-]{16}$/

function onSandbox(run: Run, sandbox: string): boolean {
  return run.source.type === 'sandbox' && run.source.id === sandbox
}

// the tasks of a run whose check keys are kept, a build file has fewer
const MAX_KEYED_TASKS = 1000

// how much of the end of a task's output its result carries
const TAIL_LINES = 20
const TAIL_LINE_LENGTH = 1000
// what a task event says of why a task ran or failed: a change to thousands of source
// files is a cause per file. The process of a run cuts them already; an executor that
// does not can still not make a result of any size.
export const MAX_CAUSES = 20
export const MAX_TASK_ERROR = 2 * 1024

function bounded(event: Extract<RunEvent, { type: 'task' }>): Extract<RunEvent, { type: 'task' }> {
  const causes = event.causes
  return {
    ...event,
    ...(causes
      ? {
          causes: [
            ...causes.slice(0, MAX_CAUSES).map((cause) => cause.slice(0, MAX_TASK_ERROR)),
            ...(causes.length > MAX_CAUSES ? [`… and ${causes.length - MAX_CAUSES} more`] : []),
          ],
        }
      : {}),
    ...(event.error !== undefined ? { error: event.error.slice(0, MAX_TASK_ERROR) } : {}),
  }
}

// what a task event weighs against the log limits of a run
function taskEventSize(event: Extract<RunEvent, { type: 'task' }>): number {
  const causes = (event.causes ?? []).reduce((sum, cause) => sum + Buffer.byteLength(cause) + 4, 0)
  return 64 + causes + Buffer.byteLength(event.error ?? '')
}

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
  private readonly maxLogBytes: number
  // callers that wait for a run to finish, let go when the server stops
  private readonly waiters = new Set<() => void>()

  constructor(private readonly options: RunRegistryOptions) {
    this.maxConcurrent = options.maxConcurrent ?? 4
    this.keep = options.keep ?? 200
    this.maxEvents = options.maxEvents ?? 5000
    this.maxWaiting = options.maxWaiting ?? 100
    this.approvalTimeout = options.approvalTimeout ?? 60 * 60 * 1000
    this.now = options.now ?? Date.now
    this.maxLogBytes = options.maxLogBytes ?? Infinity
  }

  /**
   * Takes back the runs of a previous start. Those that waited for an approval wait
   * again, for what is left of their time; those that were queued or running when the
   * server stopped failed with it, and say so.
   */
  async restore(): Promise<void> {
    const store = this.options.store
    if (!store) {
      return
    }
    const { records, skipped } = await store.load()
    skipped.forEach((name) => this.options.log?.(`skip run record ${name}: it can not be read`))
    for (const { run, events } of records) {
      const entry: Entry = {
        run,
        events,
        listeners: new Set(),
        abort: new AbortController(),
        truncated: events.some((event) => event.type === 'truncated'),
        bytes: 0,
        tails: new Map(Object.entries(run.results ?? {}).map(([task, result]) => [task, result.lastLog])),
        saving: Promise.resolve(),
        keys: {},
      }
      this.entries.set(run.id, entry)
      if (run.state === 'awaiting-approval') {
        const left = Date.parse(run.approvals?.[0]?.expiresAt ?? '') - this.now()
        if (Number.isFinite(left) && left > 0) {
          entry.timer = setTimeout(() => this.expire(entry), left)
          entry.timer.unref()
        } else {
          this.finish(entry, 'rejected', 'nobody approved it in time')
        }
      } else if (this.maySleep(entry) && ['queued', 'running', 'up', 'asleep'].includes(run.state)) {
        // the services went with the process that held them, the next request wakes them
        if (run.state === 'queued' || run.state === 'running' || run.state === 'up') {
          this.sleep(entry)
        } else {
          this.expireLater(entry)
        }
      } else if (run.state === 'queued' || run.state === 'running') {
        this.finish(entry, 'failed', `the server stopped while the run was ${run.state}, submit it again`)
      } else if (run.state === 'up') {
        // the services went with the process that held them
        this.finish(entry, 'failed', 'the server stopped while the services were up, start them again')
      }
    }
    this.evict()
  }

  // A run that needs approvals (for the accounts named) waits for them, the others
  // are queued at once.
  submit(
    owner: Pick<Principal, 'iss' | 'sub'> & Partial<Pick<Principal, 'groups' | 'claims'>>,
    spec: RunSpec,
    approvalAccounts: string[] = []
  ): Run {
    if (this.closed) {
      throw new RunError('the server is shutting down')
    }
    const waiting = approvalAccounts.length > 0
    if (waiting && this.waiting().length >= this.maxWaiting) {
      throw new RunError('too many runs are waiting for an approval')
    }
    this.checkLimits(owner, waiting)
    if (spec.up) {
      this.checkUpLimits(owner)
      this.checkHosts(owner, spec.up)
    }
    const run: Run = {
      ...spec,
      id: `run_${randomBytes(12).toString('base64url')}`,
      owner: {
        iss: owner.iss,
        sub: owner.sub,
        ...(spec.up?.sleepTtl ? { groups: [...(owner.groups ?? [])], claims: { ...(owner.claims ?? {}) } } : {}),
      },
      state: waiting ? 'awaiting-approval' : 'queued',
      createdAt: this.timestamp(),
    }
    const entry: Entry = {
      run,
      events: [],
      listeners: new Set(),
      abort: new AbortController(),
      truncated: false,
      bytes: 0,
      tails: new Map(),
      saving: Promise.resolve(),
      keys: {},
    }
    this.entries.set(run.id, entry)
    if (waiting) {
      // before the first event, which is written down with the run
      const expiresAt = new Date(this.now() + this.approvalTimeout).toISOString()
      run.approvals = approvalAccounts.map((account) => ({ account, expiresAt }))
    }
    this.record(entry, { type: 'state', state: run.state })
    if (waiting) {
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

  // `canUse` also lets who uses an account the run needed approved read it: they
  // decided about it, so they may follow it and stop it.
  get(owner: Pick<Principal, 'iss' | 'sub'>, id: string, canUse?: AccountCheck): Run | undefined {
    const entry = this.find(owner, id, canUse)
    return entry ? this.copy(entry.run) : undefined
  }

  // newest first
  list(owner: Pick<Principal, 'iss' | 'sub'>): Run[] {
    return [...this.entries.values()]
      .filter((entry) => this.owns(owner, entry))
      .map((entry) => this.copy(entry.run))
      .reverse()
  }

  // A queued run is cancelled at once; a running one when its executor stops. A service run
  // that is up stops its services, and says who stopped it.
  cancel(owner: Pick<Principal, 'iss' | 'sub'>, id: string, canUse?: AccountCheck): Run | undefined {
    const entry = this.find(owner, id, canUse)
    if (!entry) {
      return undefined
    }
    this.stop(entry, undefined, { iss: owner.iss, sub: owner.sub })
    return this.copy(entry.run)
  }

  /**
   * Moves the end of a service run that is up (or asleep) to `ttl` (ms) from now, at most
   * the server's maxTtl, and never sooner than it was. Its owner may, and whoever `mayOpen`
   * says may open its endpoints.
   */
  extend(
    caller: Pick<Principal, 'iss' | 'sub'>,
    id: string,
    ttl: number,
    mayOpen?: (run: Run) => boolean
  ): { status: 'ok'; run: Run } | { status: 'not-found' } | { status: 'not-up'; state: RunState } {
    const entry = this.entries.get(id)
    if (!entry || !(this.owns(caller, entry) || (entry.run.up && mayOpen?.(this.copy(entry.run))))) {
      return { status: 'not-found' }
    }
    // up, asleep, or woken and starting again
    if (!entry.run.upAt || isFinal(entry.run.state)) {
      return { status: 'not-up', state: entry.run.state }
    }
    // never sooner than it was: who wants it gone stops it
    const ms = Math.min(ttl, this.options.up?.maxTtl ?? ttl)
    const expiresAt = Math.max(Date.parse(entry.run.expiresAt ?? '') || 0, this.now() + ms)
    entry.run.expiresAt = new Date(expiresAt).toISOString()
    this.record(entry, { type: 'extended', by: { iss: caller.iss, sub: caller.sub }, expiresAt: entry.run.expiresAt })
    this.expireLater(entry)
    return { status: 'ok', run: this.copy(entry.run) }
  }

  /**
   * The service run an endpoint host belongs to: the newest that is up, so one that replaces
   * a run of the same name takes its hosts over as soon as it is up; else the newest that
   * had it, for a page that says how it stands. With the address of the endpoint when up.
   */
  endpoint(host: string): { run: Run; endpoint: RunEndpoint; target?: EndpointTarget } | undefined {
    let found: { entry: Entry; endpoint: RunEndpoint } | undefined
    for (const entry of this.entries.values()) {
      const endpoint = entry.run.up?.endpoints.find((candidate) => candidate.host === host)
      if (endpoint && (entry.run.state === 'up' || found?.entry.run.state !== 'up')) {
        found = { entry, endpoint }
      }
    }
    if (!found) {
      return undefined
    }
    const { entry, endpoint } = found
    const target =
      entry.run.state === 'up'
        ? entry.targets?.find((candidate) => candidate.service === endpoint.service && candidate.port === endpoint.port)
        : undefined
    return { run: this.copy(entry.run), endpoint: { ...endpoint }, ...(target ? { target } : {}) }
  }

  // The run that holds a sandbox: the oldest on it that is not over. It holds it from
  // when it is submitted, so the files are not moved under what an approver saw. A service
  // run that is up works on a copy of the files, and holds it no longer.
  holder(sandbox: string): string | undefined {
    return [...this.entries.values()].find(
      (entry) =>
        onSandbox(entry.run, sandbox) &&
        !isFinal(entry.run.state) &&
        entry.run.state !== 'up' &&
        entry.run.state !== 'asleep'
    )?.run.id
  }

  // Cancels every run on a sandbox and resolves when none of them runs anymore.
  async stopSandbox(sandbox: string, reason: string): Promise<void> {
    const on = () => [...this.entries.values()].filter((entry) => onSandbox(entry.run, sandbox))
    on().forEach((entry) => this.stop(entry, reason))
    while (on().some((entry) => entry.run.state === 'running' || entry.run.state === 'up')) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  private stop(entry: Entry, reason?: string, by?: Identity): void {
    if (entry.run.state === 'queued') {
      this.queue.splice(this.queue.indexOf(entry), 1)
      this.finish(entry, 'cancelled', reason)
    } else if (entry.run.state === 'awaiting-approval') {
      this.finish(entry, 'cancelled', reason)
    } else if (entry.run.state === 'running') {
      entry.abort.abort()
    } else if (entry.run.state === 'up') {
      entry.run.stoppedBy ??= by ?? 'replaced'
      entry.sleeping = false
      entry.abort.abort()
    } else if (entry.run.state === 'asleep') {
      entry.run.stoppedBy ??= by ?? 'replaced'
      this.finish(entry, 'succeeded')
    }
  }

  // The runs that wait for an approval, of anybody, oldest first. Who may see
  // them is for the caller to decide.
  waiting(): Run[] {
    return [...this.entries.values()]
      .filter((entry) => entry.run.state === 'awaiting-approval')
      .map((entry) => this.copy(entry.run))
  }

  // One run that waits (or waited), if `canDecide` says the decider uses one of the
  // accounts it still needs approved.
  getForApproval(id: string, canDecide: AccountCheck): Run | undefined {
    const entry = this.entries.get(id)
    if (!entry || !this.mayDecide(entry, canDecide)) {
      return undefined
    }
    return this.copy(entry.run)
  }

  // An approval covers the accounts the approver uses; the run is queued when all
  // of its accounts are covered. A rejection by anybody who covers one of them ends
  // it. Nobody decides on their own run.
  decide(
    decider: Pick<Principal, 'iss' | 'sub'>,
    id: string,
    outcome: 'approved' | 'rejected',
    canDecide: AccountCheck,
    reason?: string
  ): DecisionResult {
    const entry = this.entries.get(id)
    if (!entry || !this.mayDecide(entry, canDecide)) {
      return { status: 'not-found' }
    }
    if (this.owns(decider, entry)) {
      return { status: 'own-run' }
    }
    if (entry.run.state !== 'awaiting-approval' || !entry.run.approvals) {
      return { status: 'not-waiting', state: entry.run.state }
    }
    const by = { iss: decider.iss, sub: decider.sub }
    const covered = entry.run.approvals.filter((approval) => !approval.approvedBy && canDecide(approval.account))
    if (outcome === 'approved' && covered.length === 0) {
      return { status: 'already-approved' }
    }
    const accounts = entry.run.approvals
      .filter((approval) => canDecide(approval.account))
      .map((approval) => approval.account)
    this.record(entry, { type: 'approval', outcome, by, accounts, ...(reason ? { reason } : {}) })
    if (outcome === 'rejected') {
      this.finish(entry, 'rejected', `rejected by ${by.sub}${reason ? `: ${reason}` : ''}`)
      return { status: 'ok', run: this.copy(entry.run) }
    }
    const approvedAt = this.timestamp()
    for (const approval of covered) {
      approval.approvedBy = by
      approval.approvedAt = approvedAt
    }
    if (entry.run.approvals.some((approval) => !approval.approvedBy)) {
      // some accounts still wait for somebody who uses them
      return { status: 'ok', run: this.copy(entry.run) }
    }
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
    listener: (event: StoredEvent) => void,
    canUse?: AccountCheck
  ): { events: StoredEvent[]; finished: boolean; stop: () => void } | undefined {
    const entry = this.find(owner, id, canUse)
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

  /**
   * The run once it is over (a service run: once it is up), or as it is after `ms` or when
   * `signal` aborts, for clients that can not hold a stream of events open (a tool call of
   * an agent).
   */
  async wait(
    owner: Pick<Principal, 'iss' | 'sub'>,
    id: string,
    ms: number,
    canUse?: AccountCheck,
    signal?: AbortSignal
  ): Promise<Run | undefined> {
    const entry = this.find(owner, id, canUse)
    if (!entry) {
      return undefined
    }
    if (!isFinal(entry.run.state) && entry.run.state !== 'up' && ms > 0 && !this.closed && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const listener = (event: StoredEvent) => {
          // a service run is there once it is up
          if (event.type === 'state' && (isFinal(event.state) || event.state === 'up')) {
            done()
          }
        }
        const done = () => {
          clearTimeout(timer)
          entry.listeners.delete(listener)
          this.waiters.delete(done)
          signal?.removeEventListener('abort', done)
          resolve()
        }
        const timer = setTimeout(done, ms)
        timer.unref()
        entry.listeners.add(listener)
        this.waiters.add(done)
        signal?.addEventListener('abort', done, { once: true })
      })
    }
    return this.copy(entry.run)
  }

  // The log of a run as far as it was kept, and whether it was cut off.
  logs(
    owner: Pick<Principal, 'iss' | 'sub'>,
    id: string,
    canUse?: AccountCheck
  ): { events: StoredEvent[]; index: LogIndex; truncated: boolean } | undefined {
    const entry = this.find(owner, id, canUse)
    if (!entry) {
      return undefined
    }
    // only the events since the last read are looked at
    entry.index ??= new LogIndex()
    entry.index.update(entry.events)
    return { events: entry.events, index: entry.index, truncated: entry.truncated }
  }

  // Stops accepting runs and aborts the ones in flight.
  async close(): Promise<void> {
    this.closed = true
    for (const entry of this.queue.splice(0)) {
      if (this.maySleep(entry) && this.options.store) {
        // a woken service run sleeps again, the next start keeps it
        this.sleep(entry)
      } else {
        this.finish(entry, 'cancelled')
      }
    }
    for (const entry of this.entries.values()) {
      if (entry.run.state === 'asleep') {
        this.clearTimer(entry)
      } else if (entry.run.state === 'awaiting-approval') {
        if (this.options.store) {
          // the record keeps it waiting, the next start takes it back
          this.clearTimer(entry)
        } else {
          this.finish(entry, 'cancelled')
        }
      }
    }
    // who waits for a run that waits for an approval is told how it stands now
    for (const done of [...this.waiters]) {
      done()
    }
    for (const entry of this.entries.values()) {
      if (entry.run.state === 'running' || entry.run.state === 'up') {
        // a service run that may sleep is asleep in its record, the next request after the
        // start wakes it
        entry.sleeping = this.maySleep(entry) && !!this.options.store
        entry.abort.abort()
      }
    }
    while (
      this.running > 0 ||
      [...this.entries.values()].some((entry) => entry.run.state === 'running' || entry.run.state === 'up')
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    // the runs that were stopped are written down before the server is gone
    await Promise.all([...this.entries.values()].map((entry) => entry.saving))
  }

  private find(owner: Pick<Principal, 'iss' | 'sub'>, id: string, canUse?: AccountCheck): Entry | undefined {
    const entry = this.entries.get(id)
    return entry && (this.owns(owner, entry) || (canUse && this.mayDecide(entry, canUse))) ? entry : undefined
  }

  // Whoever uses an account the run needed approved is to see it and decide.
  private mayDecide(entry: Entry, canDecide: AccountCheck): boolean {
    return (entry.run.approvals ?? []).some((approval) => canDecide(approval.account))
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
      ...(run.up ? { up: JSON.parse(JSON.stringify(run.up)) } : {}),
      ...(run.stoppedBy && typeof run.stoppedBy === 'object' ? { stoppedBy: { ...run.stoppedBy } } : {}),
      tasks: [...run.tasks],
      source: { ...run.source },
      options: JSON.parse(JSON.stringify(run.options)),
      owner: { ...run.owner },
      accounts: [...run.accounts],
      ...(run.approvals ? { approvals: JSON.parse(JSON.stringify(run.approvals)) } : {}),
      ...(run.results ? { results: JSON.parse(JSON.stringify(run.results)) } : {}),
    }
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString()
  }

  // What a caller has now, against what they may have.
  private checkLimits(owner: Pick<Principal, 'iss' | 'sub'>, waiting: boolean): void {
    const limits = this.options.limits
    if (!limits) {
      return
    }
    const mine = [...this.entries.values()].filter((entry) => this.owns(owner, entry))
    const count = (state: RunState) => mine.filter((entry) => entry.run.state === state).length
    if (waiting && count('awaiting-approval') >= limits.waiting) {
      throw new QuotaError(`you have ${limits.waiting} runs waiting for an approval, wait for a decision or cancel one`)
    }
    if (!waiting && count('queued') >= limits.queued) {
      throw new QuotaError(`you have ${limits.queued} runs in the queue, wait for one to start or cancel one`)
    }
  }

  // Service runs that are not over, of the caller and of everybody, against what may be:
  // one that is asleep counts, it wakes without asking for a place.
  private checkUpLimits(owner: Pick<Principal, 'iss' | 'sub'>): void {
    const limits = this.options.up
    if (!limits) {
      return
    }
    const open = [...this.entries.values()].filter((entry) => entry.run.up && !isFinal(entry.run.state))
    if (open.filter((entry) => this.owns(owner, entry)).length >= limits.perCaller) {
      throw new QuotaError(
        `you have ${limits.perCaller} service runs starting, up or asleep, stop one or wait for its end`
      )
    }
    if (open.length >= limits.total) {
      throw new RunError(`the server has ${limits.total} service runs starting, up or asleep, try again later`)
    }
  }

  // A host is one run's, or a run's that replaces it (same owner and name) once it is up:
  // two labels that come out the same are refused, they would reach each other's services.
  private checkHosts(owner: Pick<Principal, 'iss' | 'sub'>, up: ServiceRunSpec): void {
    const hosts = new Set(up.endpoints.map((endpoint) => endpoint.host))
    for (const entry of this.entries.values()) {
      if (isFinal(entry.run.state) || !entry.run.up) {
        continue
      }
      const taken = entry.run.up.endpoints.find((endpoint) => hosts.has(endpoint.host))
      if (taken && !(this.owns(owner, entry) && entry.run.up.name === up.name)) {
        const error = new RunError(`the address ${taken.host} is another service run's, pick another name`)
        error.status = 409
        throw error
      }
    }
  }

  private runningOf(owner: Pick<Principal, 'iss' | 'sub'>): number {
    return [...this.entries.values()].filter((entry) => entry.run.state === 'running' && this.owns(owner, entry)).length
  }

  // Whether a run on the same sandbox executes: a sandbox runs one at a time.
  private sandboxBusy(run: Run): boolean {
    const source = run.source
    return (
      source.type === 'sandbox' &&
      [...this.entries.values()].some((entry) => entry.run.state === 'running' && onSandbox(entry.run, source.id))
    )
  }

  // Whether a run that executes holds what the run would (RunExecutor.exclusive)
  private held(run: Run): boolean {
    const exclusive = this.options.executor.exclusive?.bind(this.options.executor)
    const key = exclusive?.(run)
    return (
      key !== undefined &&
      [...this.entries.values()].some((entry) => entry.run.state === 'running' && exclusive?.(entry.run) === key)
    )
  }

  // The first run in the queue whose caller has a place left: one caller with many runs
  // does not keep the others from the machine. A run on a sandbox another run works on
  // waits for it, as does one that needs what an executing run holds.
  private dispatch(): void {
    while (this.running < this.maxConcurrent) {
      const perCaller = this.options.limits?.running ?? Infinity
      const index = this.queue.findIndex(
        (entry) => this.runningOf(entry.run.owner) < perCaller && !this.sandboxBusy(entry.run) && !this.held(entry.run)
      )
      if (index < 0) {
        return
      }
      const [entry] = this.queue.splice(index, 1)
      this.running++
      this.execute(entry).finally(() => {
        // a service run that is up gave its place back already
        if (!entry.released) {
          this.running--
        }
        this.dispatch()
      })
    }
  }

  private async execute(entry: Entry): Promise<void> {
    entry.run.state = 'running'
    entry.run.startedAt = this.timestamp()
    this.record(entry, { type: 'state', state: 'running' })
    // a service run gets this long to be up, then its ttl counts
    const limit = this.options.maxDuration
    entry.durationTimer = limit
      ? setTimeout(() => {
          entry.timedOut = true
          entry.abort.abort()
        }, limit)
      : undefined
    entry.durationTimer?.unref()
    try {
      await this.options.executor.execute(this.copy(entry.run), {
        emit: (event) => this.record(entry, event),
        signal: entry.abort.signal,
        ...(entry.run.up ? { up: (targets: EndpointTarget[]) => this.markUp(entry, targets) } : {}),
      })
      if (entry.sleeping) {
        this.sleep(entry)
      } else if (entry.run.upAt) {
        // services stay until they are stopped: ones that stopped on their own failed
        this.endServices(entry, 'the services stopped on their own')
      } else {
        this.finish(
          entry,
          entry.timedOut ? 'failed' : entry.abort.signal.aborted ? 'cancelled' : 'succeeded',
          entry.timedOut ? this.tooLong() : undefined
        )
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (entry.sleeping) {
        this.sleep(entry)
      } else if (entry.run.upAt) {
        this.endServices(entry, message)
      } else {
        const cancelled = entry.abort.signal.aborted && !entry.timedOut
        this.finish(
          entry,
          cancelled ? 'cancelled' : 'failed',
          entry.timedOut ? this.tooLong() : cancelled ? undefined : message
        )
      }
    } finally {
      clearTimeout(entry.durationTimer)
    }
  }

  // The services of a service run are ready: its ttl counts from now, its place of
  // maxConcurrent goes to the next run, and an older run of its owner with the same name
  // stops, so its hosts are this run's.
  private markUp(entry: Entry, targets: EndpointTarget[]): void {
    const spec = entry.run.up
    if (!spec || entry.run.state !== 'running' || entry.abort.signal.aborted) {
      return
    }
    clearTimeout(entry.durationTimer)
    entry.durationTimer = undefined
    entry.targets = targets.map((target) => ({ ...target, address: { ...target.address } }))
    entry.run.state = 'up'
    // one reading of the clock, so the ttl is exactly expiresAt - upAt
    const now = this.now()
    // the ttl counts from the first time, not from a wake
    if (!entry.run.upAt) {
      entry.run.upAt = new Date(now).toISOString()
      entry.run.expiresAt = new Date(now + spec.ttl).toISOString()
    }
    if (spec.sleepTtl) {
      entry.run.sleepsAt = new Date(now + spec.sleepTtl).toISOString()
    }
    this.record(entry, { type: 'state', state: 'up' })
    this.expireLater(entry)
    entry.released = true
    this.running--
    const entries = [...this.entries.values()]
    for (const other of entries.slice(0, entries.indexOf(entry))) {
      if (
        other.run.up?.name === spec.name &&
        this.owns(entry.run.owner, other) &&
        !isFinal(other.run.state) &&
        other.run.state !== 'awaiting-approval'
      ) {
        other.run.stoppedBy = 'replaced'
        this.stop(other, `replaced by ${entry.run.id}`)
      }
    }
    this.dispatch()
  }

  // Stops a service run at its expiry, and puts one that is up to sleep at its sleepsAt. A
  // timer can't wait longer than about 24 days, so a longer one looks again then.
  private expireLater(entry: Entry): void {
    this.clearTimer(entry)
    const expiresAt = Date.parse(entry.run.expiresAt ?? '')
    const sleepsAt = entry.run.state === 'up' ? Date.parse(entry.run.sleepsAt ?? '') : NaN
    const next = Number.isFinite(sleepsAt) ? Math.min(expiresAt, sleepsAt) : expiresAt
    entry.timer = setTimeout(
      () => {
        if (isFinal(entry.run.state)) {
          return
        }
        if (Date.parse(entry.run.expiresAt ?? '') <= this.now()) {
          entry.run.stoppedBy ??= 'ttl'
          entry.sleeping = false
          if (entry.run.state === 'asleep') {
            this.finish(entry, 'succeeded')
          } else {
            this.stop(entry)
          }
          return
        }
        if (entry.run.state === 'up' && Date.parse(entry.run.sleepsAt ?? '') <= this.now()) {
          entry.sleeping = true
          entry.abort.abort()
          return
        }
        this.expireLater(entry)
      },
      Math.max(0, Math.min(next - this.now(), 2 ** 31 - 1))
    )
    entry.timer.unref()
  }

  // Whether a service run sleeps instead of ending: it has a sleepTtl, its ttl has not
  // ended, and it starts from a commit (the files of a sandbox change under it).
  private maySleep(entry: Entry): boolean {
    return (
      !!entry.run.up?.sleepTtl &&
      !!entry.run.upAt &&
      entry.run.source.type === 'ref' &&
      Date.parse(entry.run.expiresAt ?? '') > this.now()
    )
  }

  // The services stopped, the run waits for a request to wake it, or for its end.
  private sleep(entry: Entry): void {
    entry.sleeping = false
    entry.targets = undefined
    entry.run.state = 'asleep'
    delete entry.run.sleepsAt
    this.record(entry, { type: 'state', state: 'asleep' })
    this.expireLater(entry)
  }

  /**
   * A request to an endpoint of a service run: one that is up stays up for its sleepTtl from
   * now, one that is asleep is started again (it holds its place of runs.up.limits while it
   * sleeps), if `mayWake` finds its owner may still run it: else it ends. Answers why it was
   * not woken, or undefined.
   */
  visit(id: string, mayWake?: (run: Run) => string | undefined): string | undefined {
    const entry = this.entries.get(id)
    if (!entry?.run.up) {
      return undefined
    }
    const sleepTtl = entry.run.up.sleepTtl
    if (entry.run.state === 'up' && sleepTtl) {
      // only kept in memory: a server that stops puts the run to sleep anyway
      entry.run.sleepsAt = new Date(this.now() + sleepTtl).toISOString()
      return undefined
    }
    if (entry.run.state !== 'asleep' || this.closed) {
      return undefined
    }
    if (!this.maySleep(entry)) {
      this.expireLater(entry)
      return 'its time ran out'
    }
    const refused = mayWake?.(this.copy(entry.run))
    if (refused) {
      this.finish(entry, 'failed', refused)
      return refused
    }
    this.clearTimer(entry)
    entry.abort = new AbortController()
    entry.released = false
    entry.timedOut = false
    entry.run.wakes = (entry.run.wakes ?? 0) + 1
    entry.run.state = 'queued'
    this.record(entry, { type: 'state', state: 'queued' })
    this.queue.push(entry)
    this.dispatch()
    return undefined
  }

  // The end of a run that was up: stopped by somebody, its ttl or a newer run it succeeded,
  // stopped by the server going away it failed, as its record says after a restart.
  private endServices(entry: Entry, failure: string): void {
    if (entry.timedOut) {
      this.finish(entry, 'failed', this.tooLong())
    } else if (!entry.abort.signal.aborted) {
      this.finish(entry, 'failed', failure)
    } else if (entry.run.stoppedBy) {
      this.finish(entry, 'succeeded')
    } else {
      this.finish(entry, 'failed', 'the server stopped while the services were up, start them again')
    }
  }

  private tooLong(): string {
    return `the run took longer than ${formatDuration(this.options.maxDuration as number)} and was stopped`
  }

  private finish(entry: Entry, state: RunState, error?: string): void {
    this.clearTimer(entry)
    clearTimeout(entry.durationTimer)
    entry.targets = undefined
    entry.run.state = state
    entry.run.finishedAt = this.timestamp()
    if (error) {
      entry.run.error = error
    }
    // a task the executor did not see to its end did not finish
    for (const result of Object.values(entry.run.results ?? {})) {
      if (result.status === 'running') {
        result.status = 'cancelled'
        result.finishedAt = entry.run.finishedAt
      }
    }
    this.record(entry, { type: 'state', state, ...(error ? { error } : {}) }, true)
    entry.listeners.clear()
    try {
      this.options.onFinished?.(this.copy(entry.run), { ...entry.keys })
    } catch (e) {
      this.options.log?.(
        `run ${entry.run.id} ended, but what it passed was not kept: ${e instanceof Error ? e.message : e}`
      )
    }
    this.evict()
  }

  private record(entry: Entry, recorded: RunEvent, force = false): void {
    if (recorded.type === 'key') {
      // a task name is the executor's; the first key it reports for a task is the one
      // computed before anything of the run had run
      if (!(recorded.task in entry.keys) && Object.keys(entry.keys).length < MAX_KEYED_TASKS) {
        entry.keys[recorded.task] = recorded.key
      }
      return
    }
    const event = recorded.type === 'task' ? bounded(recorded) : recorded
    if (event.type === 'log') {
      this.keepTail(entry, event.task, event.text)
    } else if (event.type === 'task') {
      this.keepResult(entry, event)
    }
    // an executor that keeps talking can't fill the memory of the server or its disk; the
    // state changes, which are few, are always kept, and the results above are kept apart
    if (!force && event.type !== 'state') {
      const size =
        event.type === 'log' ? Buffer.byteLength(event.text) + 64 : event.type === 'task' ? taskEventSize(event) : 64
      if (entry.events.length >= this.maxEvents || entry.bytes + size > this.maxLogBytes) {
        if (!entry.truncated) {
          entry.truncated = true
          this.push(entry, { type: 'truncated' })
        }
        return
      }
      entry.bytes += size
    }
    this.push(entry, event)
  }

  private keepTail(entry: Entry, task: string, text: string): void {
    let tail = entry.tails.get(task)
    if (!tail) {
      tail = []
      entry.tails.set(task, tail)
    }
    for (const line of text.replace(/\r?\n$/, '').split(/\r?\n/)) {
      tail.push(line.length > TAIL_LINE_LENGTH ? `${line.slice(0, TAIL_LINE_LENGTH)}…` : line)
    }
    tail.splice(0, Math.max(0, tail.length - TAIL_LINES))
  }

  private keepResult(entry: Entry, event: Extract<RunEvent, { type: 'task' }>): void {
    const results = (entry.run.results ??= {})
    let tail = entry.tails.get(event.task)
    if (!tail) {
      tail = []
      entry.tails.set(event.task, tail)
    }
    const now = this.timestamp()
    const previous = results[event.task]
    // A task the run names in several scopes is checked again as a dependency of a later
    // one: it is then cached or not needed, or stopped with the scope. What it did the
    // first time is what the caller asked about.
    if (
      previous &&
      ['succeeded', 'failed', 'cached'].includes(previous.status) &&
      ['cached', 'skipped', 'cancelled'].includes(event.state)
    ) {
      return
    }
    const over = event.state !== 'running'
    const result: TaskResult = {
      status: event.state,
      ...(event.state === 'running'
        ? { startedAt: now }
        : previous?.startedAt
          ? { startedAt: previous.startedAt }
          : {}),
      ...(over ? { finishedAt: now } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
      ...(event.error ? { error: event.error } : {}),
      ...(event.state === 'cached'
        ? { cache: { hit: true } }
        : event.state === 'succeeded' || event.state === 'failed'
          ? { cache: { hit: false, ...(event.causes?.length ? { causes: [...event.causes] } : {}) } }
          : {}),
      // the same list the log adds to, so the result always has the newest lines
      lastLog: tail,
    }
    results[event.task] = result
  }

  private push(entry: Entry, event: RunEvent): void {
    const stored = { ...event, seq: entry.events.length + 1, time: this.timestamp() } as StoredEvent
    entry.events.push(stored)
    for (const listener of entry.listeners) {
      listener(stored)
    }
    // what a restart must not lose: the runs that wait, and how a run ended. A running
    // run is not kept up to date, it fails with the server.
    if (event.type === 'state' || event.type === 'approval' || event.type === 'extended') {
      this.persist(entry)
    }
  }

  private persist(entry: Entry): void {
    const store = this.options.store
    if (!store) {
      return
    }
    const record = { run: this.copy(entry.run), events: [...entry.events] }
    entry.saving = entry.saving
      .then(() => store.save(record))
      .catch((e) => this.options.log?.(`could not keep run ${record.run.id}: ${e instanceof Error ? e.message : e}`))
  }

  // Only finished runs are dropped, oldest first.
  private evict(): void {
    const finished = [...this.entries.values()].filter((entry) => FINAL_STATES.includes(entry.run.state))
    for (const entry of finished.slice(0, Math.max(0, finished.length - this.keep))) {
      this.entries.delete(entry.run.id)
      void entry.saving.then(() => this.options.store?.remove(entry.run.id)).catch(() => undefined)
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
