import colors from 'colors'
import type { Capacity, Resources } from '../server/capacity'
import { formatCpu, formatMemory } from '../server/capacity-format'
import type { ListedRun, Meter, Overview } from '../server/overview'
import { ranMs, roughly, TaskStats, waitedMs } from '../server/timings'
import { describeWait } from '../server/wait-reason'
import { printable } from './server-client'

export { describeWait }

// What a run does, in a few words: its tasks, or the services it keeps up.
export function describeWork(run: Pick<ListedRun, 'tasks' | 'up'>): string {
  if (run.up) {
    return `${printable(run.up.name)}: up ${run.up.services.map(printable).join(', ')}`
  }
  return run.tasks.length > 0 ? run.tasks.map(printable).join(', ') : 'by labels'
}

function ownerOf(run: ListedRun): string {
  return run.owner ? ` of ${printable(run.owner.sub)}` : ''
}

function describeMeter(name: string, meter: Meter): string {
  const full = meter.limit !== undefined && meter.used >= meter.limit
  const count = `${meter.used}${meter.limit !== undefined ? ` of ${meter.limit}` : ''}`
  return `  ${name.padEnd(9)} ${count.padEnd(9)} ${meter.runs.length > 0 ? meter.runs.map(printable).join(', ') : '-'}${
    full ? colors.yellow('  full') : ''
  }`
}

// A service run on one line, then a line per endpoint: when it ends, when it sleeps.
export function describeServiceRun(run: ListedRun): string[] {
  const times = [
    run.state === 'up' || run.state === 'asleep' ? (run.expiresAt ? `until ${run.expiresAt}` : '') : '',
    run.state === 'up' && run.sleepsAt ? `sleeps at ${run.sleepsAt}` : '',
    run.wakes ? `woken ${run.wakes}×` : '',
  ].filter(Boolean)
  return [
    `  ${printable(run.id)}  ${printable(run.state)}  ${describeWork(run)}${ownerOf(run)}${
      times.length > 0 ? `  ${printable(times.join(', '))}` : ''
    }`,
    ...(run.up?.endpoints ?? []).map(
      (endpoint) =>
        `    ${printable(endpoint.service)}:${endpoint.port}${endpoint.url ? `  ${printable(endpoint.url)}` : ''}`
    ),
  ]
}

// What `hammerkit remote status` prints: the places, the queue, the caller's limits.
export function describeOverview(server: string, overview: Overview, now = Date.now()): string[] {
  const lines = [
    `${printable(server)}: signed in as ${printable(overview.you.sub)}${
      overview.you.observe ? ', you observe every run' : ''
    }`,
    `places: ${overview.places.used} of ${overview.places.max} taken (runs.maxConcurrent)`,
    ...overview.places.runs.map(
      (run) =>
        `  ${printable(run.id)}  ${describeWork(run)}${ownerOf(run)}${
          run.startedAt ? `  since ${printable(run.startedAt)}, ${roughly(ranMs(run, now) ?? 0)}` : ''
        }`
    ),
  ]
  if (overview.places.others > 0) {
    lines.push(`  ${overview.places.others} ${overview.places.others === 1 ? 'run' : 'runs'} of others`)
  }
  // a place a run holds that is not running: a service run waking up, or a place not given back
  const unaccounted = overview.places.used - overview.places.runs.length - overview.places.others
  if (unaccounted > 0) {
    lines.push(`  ${unaccounted} taken by no running run`)
  }
  lines.push(`queue: ${overview.queue.length === 0 ? 'empty' : overview.queue.length}`)
  for (const entry of overview.queue) {
    const waited = entry.run ? waitedMs(entry.run, now) : undefined
    const what = entry.run
      ? `${printable(entry.run.id)}  ${describeWork(entry.run)}${ownerOf(entry.run)}${
          waited !== undefined ? `  waiting ${roughly(waited)}` : ''
        }`
      : 'a run of somebody else'
    lines.push(`  ${entry.position}. ${what}  waits: ${printable(describeWait(entry.waitsFor, entry.mine))}`)
  }
  lines.push(`waiting for an approval: ${overview.approvals.waiting} of at most ${overview.approvals.max}`)
  for (const run of overview.approvals.runs) {
    const accounts = (run.approvals ?? [])
      .filter((approval) => !approval.approvedBy)
      .map((approval) => approval.account)
    lines.push(
      `  ${printable(run.id)}  ${describeWork(run)}${ownerOf(run)}  needs ${accounts
        .map(printable)
        .join(', ')} until ${printable(run.approvals?.[0]?.expiresAt ?? '-')}`
    )
  }
  lines.push(
    `service runs: ${overview.services.open}${
      overview.services.max !== undefined ? ` of ${overview.services.max}` : ''
    } places taken on the server`
  )
  for (const run of overview.services.runs) {
    lines.push(...describeServiceRun(run))
  }
  lines.push(
    'your limits:',
    describeMeter('running', overview.limits.running),
    describeMeter('queued', overview.limits.queued),
    describeMeter('approval', overview.limits.waiting),
    describeMeter('services', overview.limits.services),
    ...(overview.limits.asleep ? [describeMeter('asleep', overview.limits.asleep)] : [])
  )
  return lines
}

// The machines of the server and what runs take of them, for `remote capacity`; `short` for
// the two lines of `remote status`.
export function describeCapacity(capacity: Capacity, short = false): string[] {
  const { machines, runs } = capacity
  const resources = (value: Resources | undefined) =>
    value ? `${formatCpu(value.cpu)} CPU, ${formatMemory(value.memory)}` : '?'
  const kind = capacity.backend === 'kubernetes' ? (machines?.count === 1 ? 'node' : 'nodes') : 'machine'
  const lines = [
    `capacity: ${
      machines
        ? `${machines.count} ${kind} with ${resources(machines.allocatable)}`
        : 'what the machines have is not known'
    }${machines?.used ? `, ${resources(machines.used)} in use` : ''}${
      machines?.load ? `, load ${machines.load.map((load) => load.toFixed(2)).join(' ')}` : ''
    }`,
    `  runs: ${runs.pods !== undefined ? `${runs.pods} pods, ` : ''}${
      runs.containers !== undefined ? `${runs.containers} containers, ` : ''
    }${capacity.backend === 'kubernetes' ? `requested ${resources(runs.requested)}` : ''}${
      runs.used ? `${capacity.backend === 'kubernetes' ? ', ' : ''}in use ${resources(runs.used)}` : ''
    }`,
  ]
  if (short) {
    return lines
  }
  for (const group of capacity.groups) {
    lines.push(
      `  ${printable(group.name)}  ${group.kind === 'service-run' ? 'service run' : 'caller'}${
        group.owner ? ` of ${printable(group.owner.sub)}` : ''
      }${group.run ? ` ${printable(group.run)}` : ''}  ${group.pods} pods  requested ${resources(group.requested)}${
        group.quota ? ` of ${resources(group.quota)}` : ''
      }${group.used ? `  in use ${resources(group.used)}` : ''}`
    )
  }
  for (const problem of capacity.problems) {
    lines.push(colors.yellow(`  not shown: ${printable(problem)}`))
  }
  return lines
}

// What the past runs of each task took, for `remote tasks`.
export function describeTaskStats(stats: TaskStats[]): string[] {
  const span = (ms: number | undefined) => (ms === undefined ? '-' : roughly(ms))
  return stats.map(
    (entry) =>
      `${printable(entry.task)}  ${printable(entry.repo)}  last ${printable(entry.last.status)} ${printable(
        entry.last.at
      )}${entry.last.durationMs !== undefined ? ` took ${roughly(entry.last.durationMs)}` : ''}  ${entry.runs} runs${
        entry.failed ? `, ${entry.failed} failed` : ''
      }${entry.cached ? `, ${entry.cached} cached` : ''}  median ${span(entry.medianMs)}, 90% ${span(
        entry.p90Ms
      )}, waited ${span(entry.medianWaitMs)}`
  )
}
