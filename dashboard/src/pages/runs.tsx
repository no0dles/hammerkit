import { Link, useSearchParams } from 'react-router'
import { type ListedRun } from '../api'
import { cut, printable, ranMs, span, waitedMs } from '../format'
import { readTimeRange, timeRangeQuery, TimeRangePicker, writeTimeRange } from '../time-range'
import { FilterPill, readChosen, writeChosen, type FilterOption } from '../filter-pill'
import { appendChosen, MorePages, rowsOf, useApiPages, useDebounced } from '../paged'
import {
  Empty,
  inputClass,
  Loading,
  PageTitle,
  Person,
  RunLink,
  Source,
  StateMark,
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

type FilterKey = 'state' | 'source' | 'task'

// what a run can be narrowed by, as the address and the API name it
const FILTERS: [FilterKey, string][] = [
  ['state', 'State'],
  ['source', 'Source'],
  ['task', 'Task'],
]

// runs of uploaded files have no repository: the API names their source `upload`
const sourceLabel = (option: FilterOption) => (option.value === 'upload' ? 'an upload' : undefined)

interface RunPage {
  runs: ListedRun[]
  next?: string
  // when the oldest run of the filters was created
  oldest?: string
}

// The runs of everybody one may see, newest first, over a period and narrowed by text and
// filters on the server, a page at a time as the list scrolls.
export function RunsPage() {
  const [params, setParams] = useSearchParams()
  const text = (params.get('q') ?? '').slice(0, 100)
  const asked = useDebounced(text.trim())
  const range = readTimeRange(params, DEFAULT_PERIOD)
  const chosen = Object.fromEntries(FILTERS.map(([key]) => [key, readChosen(params, key)])) as Record<
    FilterKey,
    string[]
  >
  const query = timeRangeQuery(range)
  query.set('scope', 'visible')
  const narrowed = appendChosen(query, chosen)
  if (asked) {
    narrowed.set('q', asked)
  }
  const runs = useApiPages<RunPage>(`/runs?${narrowed}`)
  const rows = rowsOf(
    runs,
    (page) => page.runs,
    (run) => run.id
  )
  const now = useNow()
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
  const oldest = range.type === 'all' ? runs.data?.pages[0]?.oldest : undefined
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
        {FILTERS.map(([key, name]) => (
          <FilterPill
            key={key}
            name={name}
            values={`/runs?${narrowed}&values=${key}`}
            label={key === 'source' ? sourceLabel : undefined}
            chosen={chosen[key]}
            onChange={(next) => setParams(writeChosen(params, key, next), { replace: true })}
          />
        ))}
      </div>
      <Loading query={runs}>
        {() => {
          if (rows.length === 0) {
            const filtered = asked || FILTERS.some(([key]) => chosen[key].length > 0)
            return <Empty>{filtered ? 'No run of this period is like that.' : 'No run in this period.'}</Empty>
          }
          return (
            <>
              <Table head={HEAD} right={RIGHT}>
                {rows.map((run) => (
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
                        {run.owner ? <Person who={run.owner} /> : 'you'}
                      </div>
                    </Td>
                  </tr>
                ))}
              </Table>
              <MorePages query={runs} />
            </>
          )
        }}
      </Loading>
    </>
  )
}
