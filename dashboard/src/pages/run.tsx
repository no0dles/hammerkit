import { Fragment, useState, type ReactNode } from 'react'
import type { DefinitionVersion } from '../../../src/server/definitions'
import type { TaskPlan } from '../../../src/server/plan'
import { Link, useParams, useSearchParams } from 'react-router'
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
      <Tasks run={run} full={full} />
      {/* a run that has not started has no log yet */}
      {full && 'results' in run && run.startedAt ? <LogTail run={run} /> : null}
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
  durationMs?: number
  error?: string
  cache?: string
  exitCode?: number
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
      aria-label={`${shown ? 'Hide' : 'Show'} what ${name} does`}
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
function Tasks({ run, full }: { run: FullRun | ListedRun; full: boolean }) {
  // what each task does: from the run whole, else from the version of the build file it ran,
  // for who may see build files
  const own = 'plan' in run ? run.plan : undefined
  const version = useApi<DefinitionVersion>(`/definitions/${hashPath(run.definition)}`, {
    enabled: !own,
    refresh: false,
  })
  const plan = own ?? version.data?.plan
  // a run that waits for the person to decide shows what it would do
  const [open, setOpen] = useState<Set<string> | 'all'>(run.may?.decide ? 'all' : new Set())
  const ran = new Map<string, TaskRow>(
    'results' in run && run.results
      ? Object.entries(run.results).map(([task, result]) => [
          task,
          {
            status: result.status,
            durationMs: result.durationMs,
            error: result.error,
            cache: result.cache?.hit ? 'hit' : result.cache?.causes?.map((cause) => cut(cause, 200)).join('\n'),
            exitCode: result.exitCode,
          },
        ])
      : Object.entries(('timings' in run ? run.timings : undefined) ?? {}).map(([task, timing]) => [
          task,
          { status: timing.status, durationMs: timing.durationMs, cache: timing.cached ? 'hit' : undefined },
        ])
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
  // the link that opens or closes what every one of a list does
  const toggleAll = (list: string[]) => {
    if (!plan) {
      return undefined
    }
    const allOpen = list.every((name) => !plan[name] || isOpen(name))
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
        {allOpen ? 'hide what they do' : 'show what they do'}
      </button>
    )
  }
  // what a service or task does, in a row of its own below it
  const details = (name: string, columns: number) =>
    plan?.[name] && isOpen(name) ? (
      <tr id={`does-${name}`} className="bg-stone-50/60 dark:bg-stone-950/30">
        <td colSpan={columns} className="px-3 pt-1 pb-3 pl-9">
          <PlanEntry entry={plan[name]} relations={false} />
        </td>
      </tr>
    ) : null
  const nameCell = (name: string) => (
    <span className="inline-flex items-center gap-1">
      {plan?.[name] ? (
        <Toggle name={name} shown={isOpen(name)} onClick={() => toggle(name)} />
      ) : (
        <span className="w-4" />
      )}
      {full && ran.has(name) ? (
        <Link className="link font-mono text-[0.85em]" to={`?task=${encodeURIComponent(name)}#log`}>
          {printable(name)}
        </Link>
      ) : (
        <Code className="break-normal">{name}</Code>
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

// the last lines of the log, of every task or of one
function LogTail({ run }: { run: FullRun }) {
  const [params] = useSearchParams()
  const task = params.get('task') ?? undefined
  const query = new URLSearchParams({ tail: String(LOG_LINES) })
  if (task) {
    query.set('task', task)
  }
  const log = useApi<LogPage>(`/runs/${encodeURIComponent(run.id)}/logs?${query}`)
  const id = encodeURIComponent(run.id)
  const suffix = task ? `?task=${encodeURIComponent(task)}` : ''
  return (
    <Section
      id="log"
      title="Log"
      note={
        log.data ? (
          <>
            the last {Math.min(LOG_LINES, log.data.total)} of {log.data.total} lines
            {log.data.truncated ? ', cut off at runs.maxLogBytes' : ''} ·{' '}
            <Link className="link" to={`/runs/${id}/log${suffix}`}>
              all of it
            </Link>{' '}
            ·{' '}
            <a className="link" href={`/api/runs/${id}/log.txt${suffix}`} download>
              download
            </a>
          </>
        ) : null
      }
    >
      <LogNames run={run} names={log.data?.names ?? []} chosen={task} base={`/runs/${id}`} anchor="#log" />
      <Loading query={log}>{(page) => <LogLines page={page} named={!task} />}</Loading>
    </Section>
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
