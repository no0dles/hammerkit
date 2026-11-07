import type { Principal } from './oauth'
import { canUse, getGrant, Grant } from './policy'
import type {
  RegistrySnapshot,
  Run,
  RunEndpoint,
  RunLimits,
  RunState,
  RunUsage,
  ServiceRunSpec,
  TaskStatus,
  WaitReason,
} from './runs'
import type { ServerConfig } from './server-config'
import type { Capacity } from './capacity'
import { mayOpenEndpoints } from './service-runs'
import type { VisibleWaitReason } from './wait-reason'
export { describeWait } from './wait-reason'
export type { VisibleWaitReason }

// Who looks: their identity, what their entitlements give them at this moment, and whether
// the server shows everyone with an entitlement the activity of all (`runs.activity`).
export interface Viewer {
  principal: Pick<Principal, 'iss' | 'sub'>
  grant: Grant
  activity?: boolean
}

export function getViewer(config: ServerConfig, principal: Principal): Viewer {
  return {
    principal,
    grant: getGrant(config.entitlements, principal),
    activity: config.runs.activity === 'everyone',
  }
}

// How long a task of a run took, as anybody who may see the run is shown it.
export interface TaskTiming {
  status: TaskStatus
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  cached?: boolean
}

// An endpoint of a run of somebody else: its address only for who may open it.
export type ListedEndpoint = Pick<RunEndpoint, 'service' | 'port'> & Partial<Pick<RunEndpoint, 'host' | 'url'>>

// A run as a list shows it: no results (those are read one run at a time), but how long its
// tasks took. A run of somebody else names its owner, and leaves out its plan and options
// (its arguments), which are for its owner and its approvers to read with
// GET /v1/runs/<id>; why it failed is for who may read its log.
export type ListedRun = Omit<Run, 'owner' | 'results' | 'plan' | 'options' | 'up'> &
  Partial<Pick<Run, 'plan' | 'options'>> & {
    owner?: { iss: string; sub: string }
    up?: Omit<ServiceRunSpec, 'endpoints'> & { endpoints: ListedEndpoint[] }
    timings?: Record<string, TaskTiming>
    queue?: QueuePlace
  }

export interface QueuePlace {
  position: number
  waitsFor: VisibleWaitReason
}

// One of the caller's limits: how many count against it, which ones, and how many may.
export interface Meter {
  used: number
  limit?: number
  runs: string[]
}

export interface Overview {
  you: { iss: string; sub: string; observe: boolean }
  // the places of runs.maxConcurrent: `used` counts the places taken, `runs` the runs that
  // execute in them that the caller may see, `others` the ones they may not
  places: { max: number; used: number; runs: ListedRun[]; others: number }
  // the queue in the order runs start, a run the caller may not see as a place with a reason
  queue: { position: number; mine: boolean; run?: ListedRun; waitsFor: VisibleWaitReason }[]
  approvals: { waiting: number; max: number; runs: ListedRun[] }
  services: { open: number; max?: number; runs: ListedRun[] }
  limits: { waiting: Meter; queued: Meter; running: Meter; services: Meter }
}

export function owns(viewer: Viewer, run: Run): boolean {
  return run.owner.iss === viewer.principal.iss && run.owner.sub === viewer.principal.sub
}

// Whether the caller decides about the run: they use an account it asked to be approved.
export function decides(viewer: Viewer, run: Run): boolean {
  return (run.approvals ?? []).some((approval) => canUse(viewer.grant, approval.account))
}

/**
 * Whether the caller may see a run, with the entitlements of the moment: their own; any
 * with `observe`; one that asked for an approval of an account they use (they decide about
 * it); a service run whose endpoints they may open; and any, with `runs.activity: everyone`,
 * for a caller with an entitlement.
 */
export function maySee(viewer: Viewer, run: Run): boolean {
  return (
    owns(viewer, run) ||
    viewer.grant.observe ||
    decides(viewer, run) ||
    (!!run.up && mayOpenEndpoints(viewer.grant, run)) ||
    (!!viewer.activity && viewer.grant.matched.length > 0)
  )
}

/**
 * Whether the caller may read a run whole: its tasks, why it failed and its log. Its owner,
 * who decides about it, and `observe`.
 */
export function mayRead(viewer: Viewer, run: Run): boolean {
  return owns(viewer, run) || viewer.grant.observe || decides(viewer, run)
}

export function toListedRun(viewer: Viewer, run: Run, queue?: QueuePlace): ListedRun {
  const { owner, results, plan, options, up, error, ...rest } = run
  const mine = owns(viewer, run)
  const opens = mine || viewer.grant.observe || (!!up && mayOpenEndpoints(viewer.grant, run))
  const timings = Object.fromEntries(
    Object.entries(results ?? {}).map(([task, result]) => [
      task,
      {
        status: result.status,
        ...(result.startedAt ? { startedAt: result.startedAt } : {}),
        ...(result.finishedAt ? { finishedAt: result.finishedAt } : {}),
        ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
        ...(result.cache ? { cached: result.cache.hit } : {}),
      },
    ])
  )
  return {
    ...rest,
    ...(mine ? { plan, options } : { owner: { iss: owner.iss, sub: owner.sub } }),
    ...(up
      ? {
          up: {
            ...up,
            endpoints: opens ? up.endpoints : up.endpoints.map(({ service, port }) => ({ service, port })),
          },
        }
      : {}),
    ...(error !== undefined && mayRead(viewer, run) ? { error } : {}),
    ...(Object.keys(timings).length > 0 ? { timings } : {}),
    ...(queue ? { queue } : {}),
  }
}

// A reason names a run only the caller may see.
export function visibleReason(reason: WaitReason, visible: (id: string) => boolean): VisibleWaitReason {
  if ((reason.type === 'sandbox' || reason.type === 'held') && !visible(reason.run)) {
    return { type: reason.type }
  }
  return { ...reason }
}

// Where a queued run stands, and why it waits: the run that holds it is named when the
// caller may see it.
export function queuePlace(
  registry: {
    queued(id: string): { position: number; waitsFor: WaitReason } | undefined
    peek(id: string): Run | undefined
  },
  viewer: Viewer,
  run: Pick<Run, 'id' | 'state'>
): QueuePlace | undefined {
  const queue = run.state === 'queued' ? registry.queued(run.id) : undefined
  if (!queue) {
    return undefined
  }
  const visible = (id: string) => {
    const holder = registry.peek(id)
    return !!holder && maySee(viewer, holder)
  }
  return { position: queue.position, waitsFor: visibleReason(queue.waitsFor, visible) }
}

export function getOverview(snapshot: RegistrySnapshot, usage: RunUsage, viewer: Viewer): Overview {
  const runs = new Map<string, Run>()
  for (const run of [
    ...snapshot.running,
    ...snapshot.queue.map((entry) => entry.run),
    ...snapshot.awaiting.runs,
    ...snapshot.services.runs,
  ]) {
    runs.set(run.id, run)
  }
  const visible = (id: string) => {
    const run = runs.get(id)
    return !!run && maySee(viewer, run)
  }
  const queue = snapshot.queue.map((entry, index) => {
    const place = { position: index + 1, waitsFor: visibleReason(entry.waitsFor, visible) }
    return {
      ...place,
      mine: owns(viewer, entry.run),
      ...(maySee(viewer, entry.run) ? { run: toListedRun(viewer, entry.run, place) } : {}),
    }
  })
  const running = snapshot.running.filter((run) => maySee(viewer, run))
  const limits: RunLimits | undefined = snapshot.limits
  return {
    you: { iss: viewer.principal.iss, sub: viewer.principal.sub, observe: viewer.grant.observe },
    places: {
      max: snapshot.places.max,
      used: snapshot.places.used,
      runs: running.map((run) => toListedRun(viewer, run)),
      others: snapshot.running.length - running.length,
    },
    queue,
    approvals: {
      waiting: snapshot.awaiting.runs.length,
      max: snapshot.awaiting.max,
      runs: snapshot.awaiting.runs.filter((run) => maySee(viewer, run)).map((run) => toListedRun(viewer, run)),
    },
    services: {
      open: snapshot.services.runs.length,
      ...(snapshot.services.max !== undefined ? { max: snapshot.services.max } : {}),
      runs: snapshot.services.runs.filter((run) => maySee(viewer, run)).map((run) => toListedRun(viewer, run)),
    },
    limits: {
      waiting: meter(usage.waiting, limits?.waiting),
      queued: meter(usage.queued, limits?.queued),
      running: meter(usage.running, limits?.running),
      services: meter(usage.services, snapshot.services.perCaller),
    },
  }
}

function meter(runs: string[], limit: number | undefined): Meter {
  return { used: runs.length, ...(limit !== undefined ? { limit } : {}), runs: [...runs] }
}

export type RunScope = 'mine' | 'visible' | 'all'
export type RunKind = 'tasks' | 'services'

export interface RunFilter {
  scope: RunScope
  states?: RunState[]
  kind?: RunKind
}

const STATES: RunState[] = [
  'awaiting-approval',
  'queued',
  'running',
  'up',
  'asleep',
  'succeeded',
  'failed',
  'cancelled',
  'rejected',
]

// `scope`, `state` (a comma separated list) and `kind` of GET /v1/runs.
export function parseRunFilter(params: URLSearchParams, grant: Grant): RunFilter {
  const scope = params.get('scope') ?? 'mine'
  if (scope !== 'mine' && scope !== 'visible' && scope !== 'all') {
    throw new Error('scope: mine, visible or all')
  }
  if (scope === 'all' && !grant.observe) {
    throw new FilterRefused('scope all needs an entitlement with observe')
  }
  const state = params.get('state')
  const states = state
    ? state.split(',').map((value) => {
        if (!STATES.includes(value as RunState)) {
          throw new Error(`state: one or more of ${STATES.join(', ')}`)
        }
        return value as RunState
      })
    : undefined
  const kind = params.get('kind') ?? undefined
  if (kind !== undefined && kind !== 'tasks' && kind !== 'services') {
    throw new Error('kind: tasks or services')
  }
  return { scope, ...(states ? { states } : {}), ...(kind ? { kind } : {}) }
}

export class FilterRefused extends Error {}

export function filterRuns(runs: Run[], viewer: Viewer, filter: RunFilter): Run[] {
  return runs.filter(
    (run) =>
      (filter.scope === 'mine' ? owns(viewer, run) : maySee(viewer, run)) &&
      (!filter.states || filter.states.includes(run.state)) &&
      (!filter.kind || (filter.kind === 'services') === !!run.up)
  )
}

// The machines and what the runs take, with whose the namespaces are where the caller may
// know: their own, and every one with `observe` or `runs.activity: everyone`.
export function visibleCapacity(capacity: Capacity, viewer: Viewer): Capacity {
  const everyone = viewer.grant.observe || !!viewer.activity
  return {
    ...capacity,
    // what the cluster answered is for operators; others learn that something is missing
    problems:
      viewer.grant.observe || capacity.problems.length === 0 ? capacity.problems : ['some of it could not be read'],
    groups: capacity.groups.map((group) => {
      const mine = group.owner?.iss === viewer.principal.iss && group.owner?.sub === viewer.principal.sub
      if (everyone || mine || !group.owner) {
        return group
      }
      const { owner, run, ...rest } = group
      void owner
      void run
      return rest
    }),
  }
}
