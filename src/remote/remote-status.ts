import colors from 'colors'
import type { ListedRun, Meter, Overview, VisibleWaitReason } from '../server/overview'
import { printable } from './server-client'

// What keeps a queued run from starting, in words; `mine` says whose limit it is.
export function describeWait(reason: VisibleWaitReason, mine: boolean): string {
  switch (reason.type) {
    case 'own-limit':
      return `${mine ? 'your' : 'its owner’s'} limit of running runs, ${reason.running} of ${
        reason.limit
      } (runs.limits.running)`
    case 'sandbox':
      return reason.run ? `its sandbox runs ${printable(reason.run)}` : 'another run works on its sandbox'
    case 'held':
      return reason.run ? `${printable(reason.run)} holds what it needs` : 'another run holds what it needs'
    case 'place':
      return `no free place, ${reason.used} of ${reason.max} taken (runs.maxConcurrent)`
    case 'starting':
      return 'starts now'
  }
}

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
      (endpoint) => `    ${printable(endpoint.service)}:${endpoint.port}  ${printable(endpoint.url)}`
    ),
  ]
}

// What `hammerkit remote status` prints: the places, the queue, the caller's limits.
export function describeOverview(server: string, overview: Overview): string[] {
  const lines = [
    `${printable(server)}: signed in as ${printable(overview.you.sub)}${
      overview.you.observe ? ', you observe every run' : ''
    }`,
    `places: ${overview.places.used} of ${overview.places.max} taken (runs.maxConcurrent)`,
    ...overview.places.runs.map(
      (run) =>
        `  ${printable(run.id)}  ${describeWork(run)}${ownerOf(run)}${
          run.startedAt ? `  since ${printable(run.startedAt)}` : ''
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
    const what = entry.run
      ? `${printable(entry.run.id)}  ${describeWork(entry.run)}${ownerOf(entry.run)}`
      : 'a run of somebody else'
    lines.push(`  ${entry.position}. ${what}  waits: ${describeWait(entry.waitsFor, entry.mine)}`)
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
    } on the server`
  )
  for (const run of overview.services.runs) {
    lines.push(...describeServiceRun(run))
  }
  lines.push(
    'your limits:',
    describeMeter('running', overview.limits.running),
    describeMeter('queued', overview.limits.queued),
    describeMeter('approval', overview.limits.waiting),
    describeMeter('services', overview.limits.services)
  )
  return lines
}
