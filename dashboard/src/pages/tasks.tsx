import { Fragment, useState } from 'react'
import { useSearchParams } from 'react-router'
import { type TaskStats } from '../api'
import { span } from '../format'
import { Code, Empty, inputClass, Loading, PageTitle, T, Table, Td, Time, useNow, WebLink, type SortState } from '../ui'
import { webLinks } from '../../../src/utils/web-links'
import { readTimeRange, timeRangeQuery, TimeRangePicker, writeTimeRange } from '../time-range'
import { FilterPill, readChosen, writeChosen, type FilterOption } from '../filter-pill'
import { appendChosen, MorePages, rowsOf, useApiPages, useDebounced } from '../paged'
import { BuildFileLink } from './build-file'
import { cacheRate, percent, successRate } from '../graph'

// what the numbers are over when the address names no range
const DEFAULT_PERIOD = '7d'

// of its runs, how many ended well (cached is a result that passed before), and how many came
// from the cache: cacheRate, successRate and percent (graph.tsx), which the build file page uses too

// runs of uploaded files have no repository: the API names their source `upload`
const sourceLabel = (option: FilterOption) => (option.value === 'upload' ? 'an upload' : undefined)

// what a click on a column sorts by, as `sort` of GET /v1/tasks names it; the server sorts, so
// that a page of the tasks is the first of that order
type SortKey = 'task' | 'last' | 'runs' | 'cache' | 'success' | 'median' | 'p90' | 'total'
const HEAD = ['Task', 'Last', 'Runs', 'Cache hits', 'Success', 'Median', '90%', 'Total']
// over numbers and times
const RIGHT = HEAD.map((_, index) => index >= 1)
const KEYS: SortKey[] = ['task', 'last', 'runs', 'cache', 'success', 'median', 'p90', 'total']

interface TaskPage {
  tasks: TaskStats[]
  oldest?: string
  next?: string
}

// the rows of each repository together, the repositories by name; each keeps the order it is sorted in
function byRepo(rows: TaskStats[]): [string, TaskStats[]][] {
  const groups = new Map<string, TaskStats[]>()
  for (const row of rows) {
    groups.set(row.repo, [...(groups.get(row.repo) ?? []), row])
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b))
}

function TaskRow({ entry, now }: { entry: TaskStats; now: number }) {
  const success = successRate(entry)
  const { definition, entry: file } = entry.last
  return (
    <tr>
      <Td className="whitespace-nowrap">
        <Code className="break-normal">{entry.task}</Code>
        {/* the build file its last run ran: where it is, and which version */}
        {definition ? (
          <div className="text-xs text-stone-500 dark:text-stone-400">
            <BuildFileLink hash={definition} entry={file} />{' '}
            <span className="font-mono text-[0.85em]" title={definition}>
              {definition.slice(7, 19)}
            </span>
          </div>
        ) : null}
      </Td>
      <Td num>
        <Time iso={entry.last.at} now={now} />
      </Td>
      <Td num>{entry.runs}</Td>
      <Td num>
        <span title={`${entry.cached} of ${entry.runs} from the cache`}>{percent(cacheRate(entry))}</span>
      </Td>
      <Td
        num
        className={
          success === undefined || success === 1
            ? ''
            : success < 0.5
              ? 'text-red-600 dark:text-red-400'
              : 'text-amber-600 dark:text-amber-400'
        }
      >
        <span title={`${entry.failed} of ${entry.runs} failed`}>{percent(success)}</span>
      </Td>
      <Td num>{span(entry.medianMs)}</Td>
      <Td num>{span(entry.p90Ms)}</Td>
      <Td num>{span(entry.totalMs)}</Td>
    </tr>
  )
}

// What the past runs of each task took, over a period of the runs the server keeps.
export function TasksPage() {
  const [params, setParams] = useSearchParams()
  const range = readTimeRange(params, DEFAULT_PERIOD)
  const query = timeRangeQuery(range)
  const [text, setText] = useState('')
  const asked = useDebounced(text.trim())
  const sources = readChosen(params, 'source')
  // as the server answers when it is not asked to sort: the last to run first
  const [sort, setSort] = useState<SortState<SortKey>>({ key: 'last', dir: 'desc' })
  const narrowed = appendChosen(query, { source: sources })
  if (asked) {
    narrowed.set('q', asked)
  }
  const stats = useApiPages<TaskPage>(`/tasks?${narrowed}&sort=${sort.key}&order=${sort.dir}`)
  const rows = rowsOf(
    stats,
    (page) => page.tasks,
    (entry) => `${entry.repo}\0${entry.task}`
  )
  const now = useNow()
  // text A to Z first, numbers the largest first; a second click turns the order around
  const onSort = (key: SortKey) =>
    setSort((current) =>
      current.key === key
        ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'task' ? 'asc' : 'desc' }
    )
  const oldest = stats.data?.pages[0]?.oldest
  return (
    <>
      <PageTitle>Tasks</PageTitle>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          className={`${inputClass} min-w-48 flex-1 sm:max-w-xs`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="task, build file or repository"
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
        <FilterPill
          name="Source"
          values={`/tasks?${narrowed}&values=source`}
          label={sourceLabel}
          chosen={sources}
          onChange={(next) => setParams(writeChosen(params, 'source', next), { replace: true })}
        />
      </div>
      <Loading query={stats}>
        {() => {
          if (rows.length === 0) {
            return (
              <Empty>
                {asked || sources.length > 0 ? 'No task of this period is like that.' : 'No task ran in this period.'}
              </Empty>
            )
          }
          return (
            <>
              <Table head={HEAD} right={RIGHT} sort={{ keys: KEYS, state: sort, onSort }}>
                {byRepo(rows).map(([repo, group]) => (
                  <Fragment key={repo}>
                    <tr className="bg-stone-50 dark:bg-stone-950/40">
                      <th
                        colSpan={HEAD.length}
                        scope="colgroup"
                        className="px-3 py-1.5 text-left text-xs font-medium text-stone-600 dark:text-stone-300"
                      >
                        <WebLink href={webLinks(repo)?.repo}>
                          <T>{repo}</T>
                        </WebLink>
                      </th>
                    </tr>
                    {group.map((entry) => (
                      <TaskRow key={entry.task} entry={entry} now={now} />
                    ))}
                  </Fragment>
                ))}
              </Table>
              <MorePages query={stats} />
            </>
          )
        }}
      </Loading>
    </>
  )
}
