import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import type { DefinitionVersion } from '../../../src/server/definitions'
import type { TaskPlan } from '../../../src/server/plan'
import { Link, useParams } from 'react-router'
import { buildFilePath } from './build-file'
import { hashPath, useApi, type FullRun, type ListedRun, type LogPage } from '../api'
import { cut, describeWait, formatDuration, printable, printableLine, ranMs, span, waitedMs } from '../format'
import {
  Card,
  Code,
  Decide,
  Empty,
  Endpoints,
  Facts,
  Loading,
  PageTitle,
  Person,
  Arguments,
  PlanEntry,
  Quiet,
  ExtendButton,
  StartButton,
  StopButton,
  Section,
  Source,
  State,
  StateIcon,
  T,
  Table,
  Td,
  Time,
  useNow,
  Work,
} from '../ui'

const LOG_LINES = 200

export function RunPage() {
  const id = useParams().id ?? ''
  // The lists show every run the caller sees; the run whole (GET /v1/runs/<id>) is for its
  // owner, who decides about it and `observe`, so it is asked only when the list says so. Once
  // the run whole is shown, only it is read again every 10 seconds.
  const listed = useApi<{ runs: ListedRun[] }>(`/runs?scope=visible&id=${encodeURIComponent(id)}`, {
    refresh: (data) => !readsWhole(data?.runs[0]),
  })
  const whole = readsWhole(listed.data?.runs[0])
  const full = useApi<FullRun>(`/runs/${encodeURIComponent(id)}`, { enabled: whole })
  return (
    <>
      <PageTitle>{id}</PageTitle>
      {whole ? (
        <Loading query={full}>{(run) => <RunView run={run} full />}</Loading>
      ) : (
        <Loading query={listed}>
          {({ runs }) => (runs[0] ? <RunView run={runs[0]} /> : <Empty>There is no such run you may see.</Empty>)}
        </Loading>
      )}
    </>
  )
}

function readsWhole(run: ListedRun | undefined): boolean {
  return !!run && (!run.owner || !!run.readable)
}

function RunView({ run, full = false }: { run: FullRun | ListedRun; full?: boolean }) {
  const now = useNow()
  const mine = !run.owner
  const at = (iso: string | undefined) => <Time iso={iso} now={now} />

  // what it runs and from where
  const source: [ReactNode, ReactNode][] = [
    ['Source', <Source run={run} />],
    [
      'Build file',
      <Link className="link font-mono text-[0.85em] break-all" to={buildFilePath(run.definition)}>
        {run.definition}
      </Link>,
    ],
    [run.up ? 'Services' : 'Tasks', <Work run={run} />],
  ]
  if (run.up) {
    source.push(['Endpoints', <Endpoints run={run} />])
  }
  if (run.accounts.length > 0) {
    source.push(['Accounts', run.accounts.join(', ')])
  }

  // whose it is, when it came and who let it run
  const owner: [ReactNode, ReactNode][] = [
    [
      'Owner',
      run.owner ? (
        <>
          <Person who={run.owner} />
          {run.owner.name ? null : <Quiet> at {run.owner.iss}</Quiet>}
        </>
      ) : (
        'you'
      ),
    ],
    ['Created', at(run.createdAt)],
  ]
  for (const approval of run.approvals ?? []) {
    owner.push([
      <>
        Approval of <Code>{approval.account}</Code>
      </>,
      approval.approvedBy ? (
        <>
          approved by <Code>{approval.approvedBy.sub}</Code>
        </>
      ) : (
        <>waits until {at(approval.expiresAt)}</>
      ),
    ])
  }

  // how long it waited and ran, and for a service run how long it stays
  const timing: [ReactNode, ReactNode][] = []
  const waited = waitedMs(run, now)
  if (waited !== undefined) {
    timing.push(['Waited for a place', `${span(waited)}${run.state === 'queued' ? ' so far' : ''}`])
  }
  if (run.queue) {
    timing.push(['Queue', `${run.queue.position}. waits: ${describeWait(run.queue.waitsFor, mine, false)}`])
  }
  if (run.startedAt) {
    timing.push(['Started', at(run.startedAt)])
  }
  const ran = ranMs(run, now)
  if (ran !== undefined) {
    timing.push([run.up ? 'Took to be up' : 'Ran', `${span(ran)}${run.finishedAt || run.upAt ? '' : ' so far'}`])
  }
  if (run.finishedAt) {
    timing.push(['Finished', at(run.finishedAt)])
  }
  if (run.up) {
    if (run.upAt) {
      timing.push(['Up since', at(run.upAt)])
    }
    if (run.expiresAt) {
      timing.push([
        'Ends',
        <span className="inline-flex items-center gap-2">
          {at(run.expiresAt)}
          <ExtendButton run={run} />
        </span>,
      ])
    }
    if (run.up.sleepTtl) {
      timing.push([
        'Sleeps',
        <>
          after {formatDuration(run.up.sleepTtl)} without a request
          {run.state === 'up' && run.sleepsAt ? <>, next {at(run.sleepsAt)}</> : null}
          {run.wakes ? `, woken ${run.wakes}×` : ''}
        </>,
      ])
    }
  }

  const groups: [string, [ReactNode, ReactNode][]][] = [
    ['Source', source],
    ['Owner', owner],
    ['Timing', timing],
  ]
  return (
    <>
      <Card className="mb-6 flex flex-col gap-5">
        <div className="flex items-start gap-3 text-sm">
          <State state={run.state} />
          {run.error ? (
            <span className="whitespace-pre-wrap text-red-700 dark:text-red-400">
              {printable(cut(run.error, 2000))}
            </span>
          ) : null}
          <span className="ml-auto inline-flex items-start gap-2">
            <StartButton run={run} />
            <StopButton run={run} />
          </span>
        </div>
        {run.may?.decide ? <ApproveHere run={run} now={now} /> : null}
        <div className="grid gap-5 lg:grid-cols-3">
          {groups
            .filter(([, items]) => items.length > 0)
            .map(([name, items]) => (
              <section key={name} aria-label={name}>
                <h2 className="mb-2 text-xs font-medium tracking-wide text-stone-500 uppercase dark:text-stone-400">
                  {name}
                </h2>
                {/* the names as wide in every group, so the values line up when the groups stack */}
                <Facts items={items} columns="grid-cols-[9rem_1fr] lg:grid-cols-[max-content_1fr]" />
              </section>
            ))}
        </div>
      </Card>
      <Tasks run={run} full={full} now={now} />
    </>
  )
}

// A run that waits for an account the person uses: what it needs, until when, and the buttons.
function ApproveHere({ run, now }: { run: FullRun | ListedRun; now: number }) {
  const open = (run.approvals ?? []).filter((approval) => !approval.approvedBy)
  return (
    <div className="flex flex-col gap-3 rounded-md border border-amber-500/50 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
      <p>
        Waits for your approval
        {open.length > 0 ? (
          <>
            {' '}
            of <T>{open.map((approval) => approval.account).join(', ')}</T>, until{' '}
            <Time iso={open[0]?.expiresAt} now={now} />
          </>
        ) : null}
        .
      </p>
      <Decide path={`/v1/approvals/${encodeURIComponent(run.id)}`} yes="Approve" />
    </div>
  )
}

interface TaskRow {
  status: string
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  error?: string
  cache?: string
  exitCode?: number
  // when its commands ran, once it is over and where the runtime says
  commands?: { startedAt: string; finishedAt: string }[]
}

// The tasks of a run, and the services of a service run, in the order they run: those it ran,
// and, until it ends, those still to come.
function plannedOrder(run: FullRun | ListedRun, plan: Record<string, TaskPlan> | undefined): string[] {
  if (!plan) {
    return []
  }
  const order: string[] = []
  const seen = new Set<string>()
  // each after what it depends on and needs
  const visit = (name: string) => {
    const entry = plan[name]
    if (seen.has(name) || !entry) {
      return
    }
    seen.add(name)
    for (const before of [...entry.deps, ...entry.needs]) {
      visit(before)
    }
    order.push(name)
  }
  const roots = [...run.tasks, ...(run.up?.services ?? [])]
  for (const root of roots.length > 0 ? roots : Object.keys(plan)) {
    visit(root)
  }
  return order
}

// what a task that has not run shows, by how far the run is
function notRunYet(state: string): string {
  return state === 'awaiting-approval'
    ? 'waiting'
    : state === 'queued'
      ? 'queued'
      : isOver(state)
        ? 'skipped'
        : 'pending'
}

const isOver = (state: string) => ['succeeded', 'failed', 'cancelled', 'rejected'].includes(state)

// opens and closes what a task or service does
function Toggle({ name, shown, onClick }: { name: string; shown: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={shown}
      aria-controls={`does-${name}`}
      aria-label={`${shown ? 'Hide' : 'Show'} ${name}`}
      className="-ml-1 inline-flex h-5 w-5 items-center justify-center rounded text-stone-500 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800"
    >
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className={`h-3.5 w-3.5 fill-none stroke-current transition-transform ${shown ? 'rotate-90' : ''}`}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 4l4 4-4 4" />
      </svg>
    </button>
  )
}

// The services and the tasks of a run, each in the order they run: those it ran and, until
// it ends, those still to come; what each does opens below it.
function Tasks({ run, full, now }: { run: FullRun | ListedRun; full: boolean; now: number }) {
  // what each task does: from the run whole, else from the version of the build file it ran,
  // for who may see build files
  const own = 'plan' in run ? run.plan : undefined
  const version = useApi<DefinitionVersion>(`/definitions/${hashPath(run.definition)}`, {
    enabled: !own,
    refresh: false,
  })
  const plan = own ?? version.data?.plan
  const ran = new Map<string, TaskRow>(
    'results' in run && run.results
      ? Object.entries(run.results).map(([task, result]) => [
          task,
          {
            status: result.status,
            startedAt: result.startedAt,
            finishedAt: result.finishedAt,
            durationMs: result.durationMs,
            error: result.error,
            cache: result.cache?.hit ? 'hit' : result.cache?.causes?.map((cause) => cut(cause, 200)).join('\n'),
            exitCode: result.exitCode,
            commands: result.commands,
          },
        ])
      : Object.entries(('timings' in run ? run.timings : undefined) ?? {}).map(([task, timing]) => [
          task,
          {
            status: timing.status,
            startedAt: timing.startedAt,
            finishedAt: timing.finishedAt,
            durationMs: timing.durationMs,
            cache: timing.cached ? 'hit' : undefined,
          },
        ])
  )
  // a run that waits for the person to decide shows what it would do; one that failed, the log
  // of what failed
  const [open, setOpen] = useState<Set<string> | 'all'>(() =>
    run.may?.decide
      ? 'all'
      : new Set(full ? [...ran].filter(([, row]) => row.status === 'failed').map(([name]) => name) : [])
  )
  const planned = plannedOrder(run, plan)
  // without what the build file says, what the run itself names: what ran, its tasks, its services
  const named = [...ran.keys(), ...(run.up?.services ?? []), ...run.tasks]
  const names = [...new Set([...planned, ...named])]
  if (names.length === 0) {
    return null
  }
  const isService = (name: string) => plan?.[name]?.kind === 'service' || !!run.up?.services.includes(name)
  const services = names.filter(isService)
  const tasks = names.filter((name) => !isService(name))
  const isOpen = (name: string) => open === 'all' || open.has(name)
  const toggle = (name: string) => {
    const next = new Set(open === 'all' ? names : open)
    if (next.has(name)) {
      next.delete(name)
    } else {
      next.add(name)
    }
    setOpen(next)
  }
  // what opens below a task or service: what it does, and its log once it ran
  const hasLog = (name: string) => full && ran.has(name)
  const opens = (name: string) => !!plan?.[name] || hasLog(name)
  // the link that opens or closes every one of a list
  const toggleAll = (list: string[]) => {
    if (!list.some(opens)) {
      return undefined
    }
    const allOpen = list.every((name) => !opens(name) || isOpen(name))
    return (
      <button
        type="button"
        className="link text-sm font-normal"
        onClick={() => {
          const next = new Set(open === 'all' ? names : open)
          for (const name of list) {
            if (allOpen) {
              next.delete(name)
            } else {
              next.add(name)
            }
          }
          setOpen(next)
        }}
      >
        {allOpen ? 'close all' : 'open all'}
      </button>
    )
  }
  // what a service or task does and its log, in a row of its own below it
  const details = (name: string, columns: number) =>
    opens(name) && isOpen(name) ? (
      <tr id={`does-${name}`} className="bg-stone-50/60 dark:bg-stone-950/30">
        <td colSpan={columns} className="px-3 pt-1 pb-3 pl-9">
          <TaskDetails run={run} name={name} entry={plan?.[name]} log={hasLog(name)} />
        </td>
      </tr>
    ) : null
  const nameCell = (name: string) => (
    <span className="inline-flex items-center gap-1">
      {opens(name) ? (
        <>
          <Toggle name={name} shown={isOpen(name)} onClick={() => toggle(name)} />
          <button type="button" className="cursor-pointer" onClick={() => toggle(name)} tabIndex={-1}>
            <Code className="break-normal">{name}</Code>
          </button>
        </>
      ) : (
        <>
          <span className="w-4" />
          <Code className="break-normal">{name}</Code>
        </>
      )}
    </span>
  )
  // what has not run shows how far the run is, once known; a service of a run of tasks says
  // nothing of itself, its tasks do
  const status = (name: string) => {
    const known = ran.get(name)?.status
    if (known) {
      return known
    }
    const waiting = ['awaiting-approval', 'queued'].includes(run.state)
    // the services of a service run are as the run is: up, asleep, or over
    if (run.up?.services.includes(name) && !waiting && run.state !== 'running') {
      return run.state
    }
    return waiting || run.up || !isService(name) ? notRunYet(run.state) : undefined
  }
  const serviceHead = ['Service', 'Status', 'Took']
  const taskHead = ['Task', 'Status', 'Took', 'Deps', 'Cache', ...(full ? ['Exit'] : [])]
  return (
    <>
      <Timeline run={run} names={names} ran={ran} plan={plan} now={now} />
      {services.length > 0 ? (
        <Section title="Services" note={toggleAll(services)}>
          <Table head={serviceHead} right={[false, false, true]}>
            {services.map((name) => {
              const state = status(name)
              return (
                <Fragment key={name}>
                  <tr>
                    <Td className="whitespace-nowrap">{nameCell(name)}</Td>
                    <Td>{state ? <StateIcon state={state} /> : <Quiet>–</Quiet>}</Td>
                    <Td num>{span(ran.get(name)?.durationMs)}</Td>
                  </tr>
                  {details(name, serviceHead.length)}
                </Fragment>
              )
            })}
          </Table>
        </Section>
      ) : null}
      {tasks.length > 0 ? (
        <Section title="Tasks" note={toggleAll(tasks)}>
          {full ? <Arguments args={(run as FullRun).options?.args} /> : null}
          <Table head={taskHead} right={taskHead.map((_, index) => index === 2 || index === 5)}>
            {tasks.map((task) => {
              const row = ran.get(task)
              const entry = plan?.[task]
              return (
                <Fragment key={task}>
                  <tr>
                    <Td className="whitespace-nowrap">
                      {nameCell(task)}
                      {full && row?.error ? (
                        <div className="pl-5 text-xs whitespace-pre-wrap text-red-700 dark:text-red-400">
                          {printable(cut(row.error, 500))}
                        </div>
                      ) : null}
                    </Td>
                    <Td>
                      <StateIcon state={status(task) ?? notRunYet(run.state)} />
                    </Td>
                    <Td num>{span(row?.durationMs)}</Td>
                    <Td>
                      {/* what it waits for: the tasks before it, then the services it needs */}
                      {entry && entry.deps.length + entry.needs.length > 0 ? (
                        <span className="font-mono text-[0.85em]">
                          {printable(entry.deps.join(', '))}
                          {entry.needs.length > 0 ? (
                            <span className="text-stone-500 dark:text-stone-400">
                              {entry.deps.length > 0 ? ' · ' : ''}
                              {printable(entry.needs.join(', '))}
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                    </Td>
                    <Td className="text-xs whitespace-pre-wrap">{row?.cache ? printable(row.cache) : null}</Td>
                    {full ? <Td num>{row?.exitCode ?? ''}</Td> : null}
                  </tr>
                  {details(task, taskHead.length)}
                </Fragment>
              )
            })}
          </Table>
        </Section>
      ) : null}
    </>
  )
}

// the colors of the timeline: how a task ended for the time its commands ran (or all of it,
// when it does not say when they ran); the state mark beside each says it too
const BAR_STYLES: Record<string, string> = {
  succeeded: 'bg-emerald-500 dark:bg-emerald-400',
  cached: 'bg-emerald-300 dark:bg-emerald-700',
  failed: 'bg-red-500 dark:bg-red-400',
  running: 'bg-sky-500 dark:bg-sky-400',
}
// and the steps before and around them
const STEP_STYLES = {
  waiting: 'bg-amber-400 dark:bg-amber-500',
  prepare: 'bg-violet-400 dark:bg-violet-500',
  setup: 'bg-stone-300 dark:bg-stone-600',
  tasks: 'bg-stone-400 dark:bg-stone-500',
  other: 'border border-stone-300 dark:border-stone-600',
}

type Interval = [number, number]

// how long the intervals cover together, where they overlap once
function covered(intervals: Interval[]): number {
  let sum = 0
  let reach = -Infinity
  for (const [start, end] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (end > reach) {
      sum += end - Math.max(start, reach)
      reach = end
    }
  }
  return sum
}

interface Bar {
  name: string
  status: string
  start: number
  end: number
  // when its commands ran, within the bar
  commands?: Interval[]
  // before it: what it waited for (the queue, its dependencies, a place beside the tasks
  // that run) and the run prepared
  waiting: Interval[]
  waitedFor?: string
  prepare?: Interval
}

// Where the time of a run went, a line per task and service on one scale from when the run
// was submitted to its end (or now). A line holds the steps of its task: what it waited for
// (the queue of the server for a task that depends on nothing, else its dependencies), the
// checkout and plan of the run before a first task, the setup of its container and caches,
// and when its commands ran.
function Timeline({
  run,
  names,
  ran,
  plan,
  now,
}: {
  run: FullRun | ListedRun
  names: string[]
  ran: Map<string, TaskRow>
  plan: Record<string, TaskPlan> | undefined
  now: number
}) {
  const from = Date.parse(run.createdAt)
  const to = run.finishedAt ? Date.parse(run.finishedAt) : now
  const started = run.startedAt ? Date.parse(run.startedAt) : undefined
  const bars: Bar[] = []
  for (const name of names) {
    const row = ran.get(name)
    if (!row?.startedAt) {
      continue
    }
    const start = Date.parse(row.startedAt)
    const end = row.finishedAt
      ? Date.parse(row.finishedAt)
      : row.status === 'running'
        ? now
        : start + (row.durationMs ?? 0)
    // the clocks of a cluster say seconds: what is outside the task is cut off
    const commands = row.commands
      ?.map(
        ({ startedAt, finishedAt }): Interval => [
          Math.max(start, Date.parse(startedAt)),
          Math.min(end, Date.parse(finishedAt)),
        ]
      )
      .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a)
    bars.push({ name, status: row.status, start, end, waiting: [], ...(commands?.length ? { commands } : {}) })
  }
  const byName = new Map(bars.map((bar) => [bar.name, bar]))
  // the run prepared until its first task started
  const first = Math.min(...bars.map((bar) => bar.start))
  for (const bar of bars) {
    // the dependency that ran and ended last: the task waited for it
    const last = (plan?.[bar.name]?.deps ?? [])
      .map((dep) => byName.get(dep))
      .filter((dep): dep is Bar => !!dep && dep.end <= bar.start)
      .sort((a, b) => b.end - a.end)[0]
    if (last) {
      bar.waiting = [[last.end, bar.start]]
      bar.waitedFor = last.name
    } else {
      const begun = Math.min(started ?? first, first)
      bar.waiting = [
        [from, begun],
        [first, bar.start],
      ]
      bar.prepare = [begun, first]
    }
  }
  const total = Math.max(to - from, ...bars.map((bar) => bar.end - from), 1)
  if (!bars.length) {
    return null
  }
  // the time since the run was submitted, each moment once (tasks run side by side): it
  // waited in the queue, the run prepared, a command ran, else a task set up, else a task that
  // does not say (cached, still running), else none of them (between tasks, the end)
  const extent = (bar: Bar): Interval => [bar.start, bar.end]
  const queued = started !== undefined ? Math.max(0, started - from) : total
  const inCommands = covered(bars.flatMap((bar) => bar.commands ?? []))
  const inTold = covered(bars.filter((bar) => bar.commands).map(extent))
  const inTasks = covered(bars.map(extent))
  const prepared =
    covered([...bars.flatMap((bar) => (bar.prepare ? [bar.prepare] : [])), ...bars.map(extent)]) - inTasks
  const parts: { label: string; ms: number; style: string; tip: string }[] = [
    {
      label: 'waiting',
      ms: queued,
      style: STEP_STYLES.waiting,
      tip: 'for a place in the queue or an approval; on a line, also for the dependencies of the task',
    },
    {
      label: 'prepare',
      ms: prepared,
      style: STEP_STYLES.prepare,
      tip: 'the run before its first tasks: the checkout, the namespace, the plan',
    },
    {
      label: 'setup',
      ms: inTold - inCommands,
      style: STEP_STYLES.setup,
      tip: 'a task, but no command: the pod scheduled, the image pulled, caches restored and stored',
    },
    {
      label: 'commands',
      ms: inCommands,
      style: BAR_STYLES.succeeded,
      tip: 'a command ran, in the color of how its task ended',
    },
    {
      label: 'tasks',
      ms: inTasks - inTold,
      style: STEP_STYLES.tasks,
      tip: 'a task that does not say when its commands ran: cached, still running',
    },
    {
      label: 'other',
      ms: Math.max(0, total - queued - prepared - inTasks),
      style: STEP_STYLES.other,
      tip: 'no task: between tasks, the end of the run',
    },
  ].filter((part) => part.ms >= 500)
  const share = (ms: number) => Math.min(100, Math.max(0, (ms / total) * 100))
  const place = ([start, end]: Interval) => ({ left: `${share(start - from)}%`, width: `${share(end - start)}%` })
  const segment = (key: string, interval: Interval | undefined, style: string, tip: string) =>
    interval && interval[1] > interval[0] ? (
      <div key={key} title={tip} className={`absolute inset-y-0 rounded-sm ${style}`} style={place(interval)} />
    ) : null
  const took = (interval: Interval) => span(interval[1] - interval[0]) || '0s'
  return (
    <Section title="Timeline" note={`${span(total)} since submitted${run.finishedAt ? ' until finished' : ''}`}>
      <Card>
        {/* where it went, once over the run; the legend of the lines too */}
        <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-600 dark:text-stone-300">
          {parts.map((part) => (
            <li key={part.label} className="flex cursor-help items-center gap-1.5" title={`${part.label}: ${part.tip}`}>
              <span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-sm ${part.style}`} />
              {part.label}
              <span className="text-stone-500 tabular-nums dark:text-stone-400">
                {span(part.ms) || '0s'} · {Math.round(share(part.ms))}%
              </span>
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-[minmax(6rem,max-content)_1fr_3.5rem] items-center gap-x-3 gap-y-1.5 text-sm">
          {bars.map((bar) => {
            const own: Interval = [bar.start, bar.end]
            const ranFor = bar.commands ? covered(bar.commands) : undefined
            const waitedOn = bar.waitedFor ? `for ${bar.waitedFor}` : 'in the queue, for a place'
            const waited = bar.waiting.reduce((sum, [a, b]) => sum + Math.max(0, b - a), 0)
            const steps = [
              waited > 0 ? `waited ${span(waited) || '0s'} ${waitedOn}` : '',
              bar.prepare && bar.prepare[1] > bar.prepare[0] ? `prepare ${took(bar.prepare)}` : '',
              ranFor !== undefined
                ? `setup ${span(bar.end - bar.start - ranFor) || '0s'}, commands ${span(ranFor) || '0s'}`
                : '',
            ].filter(Boolean)
            const tip = `${bar.name}: ${bar.status}, ${took(own)}${steps.length ? ` (${steps.join(', ')})` : ''}`
            const style = BAR_STYLES[bar.status] ?? STEP_STYLES.tasks
            return (
              <Fragment key={bar.name}>
                <span className="flex min-w-0 items-center gap-1.5 truncate">
                  <StateIcon state={bar.status} />
                  <Code className="break-normal">{bar.name}</Code>
                </span>
                <div
                  role="img"
                  aria-label={tip}
                  title={tip}
                  className="relative h-3 rounded-sm bg-stone-100 dark:bg-stone-800/60"
                >
                  {bar.waiting.map((interval, i) =>
                    segment(`waiting-${i}`, interval, STEP_STYLES.waiting, `waited ${took(interval)} ${waitedOn}`)
                  )}
                  {segment('prepare', bar.prepare, STEP_STYLES.prepare, 'the run prepared: checkout, namespace, plan')}
                  <div
                    title={tip}
                    className={`absolute inset-y-0 min-w-0.5 rounded-sm ${bar.commands ? STEP_STYLES.setup : style}`}
                    style={place(own)}
                  />
                  {bar.commands?.map((command, i) => (
                    <div
                      key={i}
                      title={`${bar.name}, command ${i + 1}: ${took(command)}`}
                      className={`absolute inset-y-0 min-w-0.5 rounded-sm ${style}`}
                      style={place(command)}
                    />
                  ))}
                </div>
                <span className="text-right text-xs text-stone-500 tabular-nums dark:text-stone-400">{took(own)}</span>
              </Fragment>
            )
          })}
          {/* the scale: from when the run was submitted to its end */}
          <span />
          <div className="relative h-4 text-[0.7rem] text-stone-400 tabular-nums dark:text-stone-500">
            {[0, 0.25, 0.5, 0.75, 1].map((at) => (
              <span
                key={at}
                className={`absolute top-0 whitespace-nowrap ${
                  at === 0 ? '' : at === 1 ? '-translate-x-full' : '-translate-x-1/2'
                }`}
                style={{ left: `${at * 100}%` }}
              >
                {at === 0 ? '0' : span(total * at)}
              </span>
            ))}
          </div>
          <span />
        </div>
      </Card>
    </Section>
  )
}

// What opens below a task or service: what it does and its log, a tab each where it has both
function TaskDetails({
  run,
  name,
  entry,
  log,
}: {
  run: FullRun | ListedRun
  name: string
  entry: TaskPlan | undefined
  log: boolean
}) {
  const [tab, setTab] = useState<'command' | 'log'>(log ? 'log' : 'command')
  const tabs = [...(entry ? (['command'] as const) : []), ...(log ? (['log'] as const) : [])]
  const shown = tabs.includes(tab) ? tab : tabs[0]
  return (
    <div className="flex flex-col gap-2">
      {tabs.length > 1 ? (
        <div role="tablist" aria-label={`What ${name} shows`} className="flex gap-1 text-sm">
          {tabs.map((each) => (
            <button
              key={each}
              type="button"
              role="tab"
              aria-selected={each === shown}
              onClick={() => setTab(each)}
              className={`cursor-pointer rounded-md px-2.5 py-0.5 ${
                each === shown
                  ? 'bg-stone-200 font-medium text-stone-900 dark:bg-stone-700 dark:text-white'
                  : 'text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800'
              }`}
            >
              {each === 'command' ? 'Command' : 'Log'}
            </button>
          ))}
        </div>
      ) : null}
      <div role={tabs.length > 1 ? 'tabpanel' : undefined}>
        {shown === 'log' ? (
          <TaskLog run={run} name={name} />
        ) : entry ? (
          <PlanEntry entry={entry} relations={false} />
        ) : null}
      </div>
    </div>
  )
}

// the last lines of the log of one task or service, below it, kept scrolled to the end while
// the run goes on
function TaskLog({ run, name }: { run: FullRun | ListedRun; name: string }) {
  const id = encodeURIComponent(run.id)
  const task = encodeURIComponent(name)
  const log = useApi<LogPage>(`/runs/${id}/logs?tail=${LOG_LINES}&task=${task}`, { refresh: !isOver(run.state) })
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (box.current) {
      box.current.scrollTop = box.current.scrollHeight
    }
  }, [log.data])
  return (
    <Loading query={log}>
      {(page) => (
        <div>
          <div ref={box} className="max-h-96 overflow-y-auto rounded-lg">
            <LogLines page={page} named={false} />
          </div>
          <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">
            {page.total > page.lines.length ? `the last ${page.lines.length} of ${page.total} lines · ` : ''}
            <Link className="link" to={`/runs/${id}/log?task=${task}`}>
              all of it
            </Link>{' '}
            ·{' '}
            <a className="link" href={`/api/runs/${id}/log.txt?task=${task}`} download>
              download
            </a>
          </div>
        </div>
      )}
    </Loading>
  )
}

// the tasks, services and the server's own lines a log can be narrowed to
export function LogNames({
  run,
  names,
  chosen,
  base,
  anchor = '',
}: {
  run: Pick<FullRun, 'up' | 'plan'>
  names: string[]
  chosen: string | undefined
  base: string
  anchor?: string
}) {
  const services = new Set(
    run.up?.services ??
      Object.entries(run.plan ?? {})
        .filter(([, entry]) => entry.kind === 'service')
        .map(([name]) => name)
  )
  const item = (name: string | undefined, label: ReactNode) => (
    <Link
      key={name ?? ''}
      to={`${base}${name ? `?task=${encodeURIComponent(name)}` : ''}${anchor}`}
      className={
        name === chosen
          ? 'font-medium text-stone-900 dark:text-white'
          : 'text-emerald-700 hover:underline dark:text-emerald-400'
      }
      aria-current={name === chosen ? 'page' : undefined}
    >
      {label}
    </Link>
  )
  return (
    <nav className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-sm">
      {item(undefined, 'all')}
      {names.map((name) =>
        item(
          name,
          <>
            {printable(name)}
            {name === 'hammerkit' ? <Quiet> (server)</Quiet> : services.has(name) ? <Quiet> (service)</Quiet> : null}
          </>
        )
      )}
    </nav>
  )
}

export function LogLines({ page, named }: { page: LogPage; named: boolean }) {
  if (page.lines.length === 0) {
    return <pre className="log text-stone-500">nothing yet</pre>
  }
  return (
    <pre className="log">
      {page.lines.map((line) => (
        <span key={line.line} className={line.stream === 'stderr' ? 'text-red-300' : undefined}>
          {named ? <span className="text-stone-500">[{printable(line.task)}] </span> : null}
          {line.match ? (
            <mark className="bg-amber-700 text-white">{printableLine(line.text)}</mark>
          ) : (
            printableLine(line.text)
          )}
          {'\n'}
        </span>
      ))}
    </pre>
  )
}
