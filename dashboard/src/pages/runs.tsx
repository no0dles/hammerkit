import { Link, useSearchParams } from 'react-router'
import { useApi, type ListedRun } from '../api'
import { cut, printable, ranMs, span, waitedMs } from '../format'
import { readTimeRange, timeRangeQuery, TimeRangePicker, writeTimeRange } from '../time-range'
import { countOptions, FilterPill, readChosen, writeChosen } from '../filter-pill'
import {
  Empty,
  inputClass,
  Loading,
  PageTitle,
  RunLink,
  Source,
  StateMark,
  T,
  Table,
  Td,
  Time,
  Tip,
  useNow,
  Work,
} from '../ui'

// which runs show when the address names no range
const DEFAULT_PERIOD = '7d'

const HEAD = ['Run', 'Source', 'Tasks', 'Total', 'Created']
// over times
const RIGHT = HEAD.map((_, index) => index >= 3)

// From the queue to the end, with what it waited for a place and what it ran on hover.
function Took({ run, now }: { run: ListedRun; now: number }) {
  const waited = waitedMs(run, now)
  const ran = ranMs(run, now)
  if (waited === undefined && ran === undefined) {
    return null
  }
  // a run that has not started, or ended in the queue, has no time it ran
  const parts: [string, number][] = []
  if (waited !== undefined) {
    parts.push(['Waited for a place', waited])
  }
  if (ran !== undefined) {
    parts.push(['Ran', ran])
  }
  return (
    <Tip
      tip={
        <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
          {parts.map(([name, ms]) => (
            <div key={name} className="contents">
              <dt className="text-stone-500 dark:text-stone-400">{name}</dt>
              <dd className="text-right tabular-nums">{span(ms)}</dd>
            </div>
          ))}
        </dl>
      }
    >
      {span((waited ?? 0) + (ran ?? 0))}
    </Tip>
  )
}

// the order states come in, from waiting to over
const STATES = [
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

type FilterKey = 'state' | 'source' | 'task'

// what a run can be narrowed by, as the address names it, and the values a run has for it
const FILTERS: [FilterKey, string, (run: ListedRun) => string[], string[]?][] = [
  ['state', 'State', (run) => [run.state], STATES],
  ['source', 'Source', (run) => [run.source.type === 'upload' ? 'an upload' : run.source.repo]],
  ['task', 'Task', (run) => [...run.tasks, ...(run.up?.services ?? [])]],
]

// The runs of everybody one may see, newest first, over a period and narrowed by text and filters.
export function RunsPage() {
  const [params, setParams] = useSearchParams()
  const text = (params.get('q') ?? '').slice(0, 100)
  const range = readTimeRange(params, DEFAULT_PERIOD)
  const query = timeRangeQuery(range)
  query.set('scope', 'visible')
  const runs = useApi<{ runs: ListedRun[] }>(`/runs?${query}`)
  const now = useNow()
  const chosen = Object.fromEntries(FILTERS.map(([key]) => [key, readChosen(params, key)])) as Record<
    FilterKey,
    string[]
  >
  const setText = (value: string) => {
    const next = new URLSearchParams(params)
    if (value) {
      next.set('q', value)
    } else {
      next.delete('q')
    }
    setParams(next, { replace: true })
  }
  // of all the server keeps, the oldest it lists
  const oldest =
    range.type === 'all'
      ? runs.data?.runs.reduce<string | undefined>(
          (first, run) => (!first || Date.parse(run.createdAt) < Date.parse(first) ? run.createdAt : first),
          undefined
        )
      : undefined
  return (
    <>
      <PageTitle>Runs</PageTitle>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          className={`${inputClass} min-w-48 flex-1 sm:max-w-xs`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="task, service, ref, person, id"
          aria-label="Search"
        />
        <div className="sm:ml-auto">
          <TimeRangePicker
            value={range}
            oldest={oldest}
            onChange={(next) => setParams(writeTimeRange(params, next, DEFAULT_PERIOD), { replace: true })}
          />
        </div>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {FILTERS.map(([key, name, of, order]) => (
          <FilterPill
            key={key}
            name={name}
            options={countOptions(runs.data?.runs ?? [], of, order)}
            chosen={chosen[key]}
            onChange={(next) => setParams(writeChosen(params, key, next), { replace: true })}
          />
        ))}
      </div>
      <Loading query={runs}>
        {(data) => {
          const shown = data.runs.filter(
            (run) =>
              (!text.trim() || matchesText(run, text.trim())) &&
              FILTERS.every(
                ([key, , of]) => chosen[key].length === 0 || of(run).some((value) => chosen[key].includes(value))
              )
          )
          if (shown.length === 0) {
            const narrowed = text.trim() || FILTERS.some(([key]) => chosen[key].length > 0)
            return <Empty>{narrowed ? 'No run of this period is like that.' : 'No run in this period.'}</Empty>
          }
          return (
            <Table head={HEAD} right={RIGHT}>
              {shown.map((run) => (
                <tr key={run.id}>
                  <Td>
                    <div className="flex items-start gap-2">
                      <StateMark state={run.state} />
                      <div>
                        <RunLink id={run.id} />
                        <div className="text-xs text-stone-500 dark:text-stone-400">
                          {run.may?.decide ? (
                            // waits for the person: the pause mark says it waits, this says for whom
                            <Link
                              to={`/runs/${encodeURIComponent(run.id)}`}
                              className="rounded-full bg-amber-500 px-1.5 font-medium whitespace-nowrap text-white hover:bg-amber-600"
                            >
                              your approval
                            </Link>
                          ) : (
                            run.state
                          )}
                          {run.queue ? `, ${run.queue.position}. in the queue` : null}
                        </div>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    <Source run={run} />
                  </Td>
                  <Td>
                    <Work run={run} />
                    {run.error ? (
                      <div className="text-xs whitespace-pre-wrap text-red-700 dark:text-red-400">
                        {printable(cut(run.error, 200))}
                      </div>
                    ) : null}
                  </Td>
                  <Td num>
                    <Took run={run} now={now} />
                  </Td>
                  <Td num>
                    <Time iso={run.createdAt} now={now} />
                    <div className="text-xs text-stone-500 dark:text-stone-400">
                      {run.owner ? <T>{run.owner.sub}</T> : 'you'}
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
          )
        }}
      </Loading>
    </>
  )
}

function matchesText(run: ListedRun, text: string): boolean {
  const needle = text.toLowerCase()
  const haystack = [
    run.id,
    run.owner?.sub ?? '',
    ...run.tasks,
    ...(run.up ? [run.up.name, ...run.up.services] : []),
    run.source.type === 'upload' ? '' : run.source.repo,
    run.source.type === 'ref' ? run.source.ref : '',
  ]
  return haystack.some((value) => value.toLowerCase().includes(needle))
}
