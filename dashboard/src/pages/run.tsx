import type { ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { useApi, type FullRun, type ListedRun, type LogPage, type TaskStats } from '../api'
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
  Plan,
  Quiet,
  RunButtons,
  Section,
  Source,
  State,
  Table,
  Td,
  Time,
  useNow,
  Work,
} from '../ui'

const LOG_LINES = 200

export function RunPage() {
  const id = useParams().id ?? ''
  const full = useApi<FullRun>(`/runs/${encodeURIComponent(id)}`)
  // a run of somebody else that the caller sees in lists only: as the lists show it
  const missing = full.isError && 'status' in full.error && full.error.status === 404
  const listed = useApi<{ runs: ListedRun[] }>(`/runs?scope=visible&id=${encodeURIComponent(id)}`, {
    enabled: missing,
  })
  return (
    <>
      <PageTitle>{id}</PageTitle>
      {missing ? (
        <Loading query={listed}>
          {({ runs }) => (runs[0] ? <RunView run={runs[0]} /> : <Empty>There is no such run you may see.</Empty>)}
        </Loading>
      ) : (
        <Loading query={full}>{(run) => <RunView run={run} full />}</Loading>
      )}
    </>
  )
}

function RunView({ run, full = false }: { run: FullRun | ListedRun; full?: boolean }) {
  const now = useNow()
  const mine = !run.owner
  const facts: [ReactNode, ReactNode][] = [
    [
      'State',
      <>
        <State state={run.state} />
        {run.error ? (
          <span className="ml-2 whitespace-pre-wrap text-red-700 dark:text-red-400">
            {printable(cut(run.error, 2000))}
          </span>
        ) : null}
      </>,
    ],
  ]
  if (run.owner) {
    facts.push([
      'Owner',
      <>
        <Code>{run.owner.sub}</Code> <Quiet>{run.owner.iss}</Quiet>
      </>,
    ])
  }
  facts.push(
    ['What', <Work run={run} />],
    ['Source', <Source run={run} />],
    ['Build file', <Code>{run.definition}</Code>]
  )
  if (run.accounts.length > 0) {
    facts.push(['Accounts', run.accounts.join(', ')])
  }
  facts.push(['Created', <Time iso={run.createdAt} now={now} />])
  const waited = waitedMs(run, now)
  if (waited !== undefined) {
    facts.push(['Waited for a place', `${span(waited)}${run.state === 'queued' ? ' so far' : ''}`])
  }
  if (run.startedAt) {
    facts.push(['Started', <Time iso={run.startedAt} now={now} />])
  }
  const ran = ranMs(run, now)
  if (ran !== undefined) {
    facts.push([run.up ? 'Took to be up' : 'Ran', `${span(ran)}${run.finishedAt || run.upAt ? '' : ' so far'}`])
  }
  if (run.finishedAt) {
    facts.push(['Finished', <Time iso={run.finishedAt} now={now} />])
  }
  if (run.queue) {
    facts.push(['Queue', `${run.queue.position}. waits: ${describeWait(run.queue.waitsFor, mine, false)}`])
  }
  for (const approval of run.approvals ?? []) {
    facts.push([
      <>
        Approval of <Code>{approval.account}</Code>
      </>,
      approval.approvedBy ? (
        <>
          approved by <Code>{approval.approvedBy.sub}</Code>
        </>
      ) : (
        <>
          waits until <Time iso={approval.expiresAt} now={now} />
        </>
      ),
    ])
  }
  if (run.up) {
    facts.push(['Services', printable(run.up.services.join(', '))], ['Endpoints', <Endpoints run={run} />])
    if (run.upAt) {
      facts.push(['Up since', <Time iso={run.upAt} now={now} />])
    }
    if (run.expiresAt) {
      facts.push(['Ends', <Time iso={run.expiresAt} now={now} />])
    }
    if (run.up.sleepTtl) {
      facts.push([
        'Sleeps',
        <>
          after {formatDuration(run.up.sleepTtl)} without a request
          {run.state === 'up' && run.sleepsAt ? (
            <>
              , next <Time iso={run.sleepsAt} now={now} />
            </>
          ) : null}
          {run.wakes ? `, woken ${run.wakes}×` : ''}
        </>,
      ])
    }
  }
  return (
    <>
      <Card className="mb-6 flex flex-col gap-4">
        <Facts items={facts} />
        <RunButtons run={run} />
        {run.may?.decide ? <Decide path={`/v1/approvals/${encodeURIComponent(run.id)}`} yes="Approve" /> : null}
      </Card>
      <Tasks run={run} full={full} />
      {full && 'results' in run ? (
        <>
          {run.plan ? (
            <Section title="What it runs">
              <Plan plan={run.plan} args={(run.options as { args?: unknown } | undefined)?.args} />
            </Section>
          ) : null}
          <LogTail run={run} />
        </>
      ) : (
        <Empty>
          What the tasks run, why they failed and the log are for the owner of the run and who decides about it.
        </Empty>
      )}
    </>
  )
}

interface TaskRow {
  status: string
  durationMs?: number
  error?: string
  cache?: string
  exitCode?: number
}

function Tasks({ run, full }: { run: FullRun | ListedRun; full: boolean }) {
  // what the tasks took in the runs of the repository the person may see
  const stats = useApi<{ tasks: TaskStats[] }>('/tasks')
  const rows: [string, TaskRow][] =
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
  if (rows.length === 0) {
    return null
  }
  const repo = run.source.type === 'upload' ? 'an upload' : run.source.repo
  const usual = new Map(
    (stats.data?.tasks ?? []).filter((entry) => entry.repo === repo).map((entry) => [entry.task, entry])
  )
  return (
    <Section title="Tasks">
      <Table head={['Task', 'Status', 'Took', 'Usually', 'Cache', ...(full ? ['Exit'] : [])]}>
        {rows.map(([task, row]) => {
          const usually = usual.get(task)
          return (
            <tr key={task}>
              <Td>
                {full ? (
                  <Link className="link font-mono text-[0.85em]" to={`?task=${encodeURIComponent(task)}#log`}>
                    {printable(task)}
                  </Link>
                ) : (
                  <Code>{task}</Code>
                )}
              </Td>
              <Td>
                <State state={row.status} />
                {full && row.error ? (
                  <div className="text-xs whitespace-pre-wrap text-red-700 dark:text-red-400">
                    {printable(cut(row.error, 500))}
                  </div>
                ) : null}
              </Td>
              <Td num>{span(row.durationMs)}</Td>
              <Td num>
                {usually?.medianMs !== undefined ? (
                  <>
                    {span(usually.medianMs)} <Quiet>of {usually.succeeded + usually.failed}</Quiet>
                  </>
                ) : null}
              </Td>
              <Td className="text-xs whitespace-pre-wrap">{row.cache ? printable(row.cache) : null}</Td>
              {full ? <Td num>{row.exitCode ?? ''}</Td> : null}
            </tr>
          )
        })}
      </Table>
      <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">
        Usually: the median of the runs of <span className="font-mono">{printable(repo)}</span> you may see that
        executed the task, of how many ran it.
      </p>
    </Section>
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
