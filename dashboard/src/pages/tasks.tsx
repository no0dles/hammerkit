import { Fragment, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useApi, type TaskStats } from '../api'
import { span } from '../format'
import { Code, Empty, inputClass, Loading, PageTitle, T, Table, Td, Time, useNow, useSort } from '../ui'
import { readTimeRange, timeRangeQuery, TimeRangePicker, writeTimeRange } from '../time-range'
import { BuildFileLink } from './build-file'

// what the numbers are over when the address names no range
const DEFAULT_PERIOD = '7d'

// of its runs, how many ended well (cached is a result that passed before), and how many came
// from the cache
const successRate = (entry: TaskStats) => (entry.runs ? (entry.runs - entry.failed) / entry.runs : undefined)
const cacheRate = (entry: TaskStats) => (entry.runs ? entry.cached / entry.runs : undefined)

const percent = (rate: number | undefined) => (rate === undefined ? '' : `${Math.round(rate * 100)}%`)

// what a click on a column sorts by, in each repository
const SORT_BY = {
  task: (entry: TaskStats) => entry.task,
  last: (entry: TaskStats) => Date.parse(entry.last.at),
  runs: (entry: TaskStats) => entry.runs,
  cache: cacheRate,
  success: successRate,
  median: (entry: TaskStats) => entry.medianMs,
  p90: (entry: TaskStats) => entry.p90Ms,
  total: (entry: TaskStats) => entry.totalMs,
}
const HEAD = ['Task', 'Last', 'Runs', 'Cache hits', 'Success', 'Median', '90%', 'Total']
// over numbers and times
const RIGHT = HEAD.map((_, index) => index >= 1)
const KEYS: (keyof typeof SORT_BY)[] = ['task', 'last', 'runs', 'cache', 'success', 'median', 'p90', 'total']

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
  const stats = useApi<{ tasks: TaskStats[]; oldest?: string }>(`/tasks${query.size ? `?${query}` : ''}`)
  const [text, setText] = useState('')
  const now = useNow()
  const needle = text.trim().toLowerCase()
  const sorted = useSort(
    (stats.data?.tasks ?? []).filter(
      (entry) => !needle || `${entry.repo} ${entry.task} ${entry.last.entry ?? ''}`.toLowerCase().includes(needle)
    ),
    SORT_BY,
    // as the server answers: the last to run first
    { key: 'last', dir: 'desc' }
  )
  const oldest = stats.data?.oldest
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
      <Loading query={stats}>
        {() => {
          if (sorted.rows.length === 0) {
            return <Empty>No task ran in this period.</Empty>
          }
          return (
            <Table head={HEAD} right={RIGHT} sort={{ keys: KEYS, state: sorted.state, onSort: sorted.onSort }}>
              {byRepo(sorted.rows).map(([repo, rows]) => (
                <Fragment key={repo}>
                  <tr className="bg-stone-50 dark:bg-stone-950/40">
                    <th
                      colSpan={HEAD.length}
                      scope="colgroup"
                      className="px-3 py-1.5 text-left text-xs font-medium text-stone-600 dark:text-stone-300"
                    >
                      <T>{repo}</T>
                    </th>
                  </tr>
                  {rows.map((entry) => (
                    <TaskRow key={entry.task} entry={entry} now={now} />
                  ))}
                </Fragment>
              ))}
            </Table>
          )
        }}
      </Loading>
    </>
  )
}
