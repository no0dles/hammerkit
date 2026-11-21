import { ListParamError } from './paging'
import type { TaskStats } from './timings'

// what GET /v1/tasks?values= answers the values of: where the tasks ran from
export const TASK_FIELDS = ['source'] as const

// where the runs of a task are from, as the source filter of the runs names it
export function taskSource(stats: Pick<TaskStats, 'repo'>): string {
  return stats.repo === 'an upload' ? 'upload' : stats.repo
}

// of its runs, how many came from the cache, and how many ended well (cached passed before)
const rate = (part: number, stats: TaskStats) => (stats.runs ? part / stats.runs : undefined)

// what `sort` of GET /v1/tasks orders by: the columns of the Tasks page
const SORT_BY: Record<string, (stats: TaskStats) => string | number | undefined> = {
  task: (stats) => stats.task,
  last: (stats) => Date.parse(stats.last.at),
  runs: (stats) => stats.runs,
  cache: (stats) => rate(stats.cached, stats),
  success: (stats) => rate(stats.runs - stats.failed, stats),
  median: (stats) => stats.medianMs,
  p90: (stats) => stats.p90Ms,
  total: (stats) => stats.totalMs,
}

export interface TaskOrder {
  sort: string
  order: 'asc' | 'desc'
}

// `sort` and `order` (asc or desc, desc when left out): undefined when the caller names no sort.
export function parseTaskOrder(params: URLSearchParams): TaskOrder | undefined {
  const sort = params.get('sort')
  if (sort === null) {
    return undefined
  }
  if (!(sort in SORT_BY)) {
    throw new ListParamError(`sort: one of ${Object.keys(SORT_BY).join(', ')}`)
  }
  const order = params.get('order') ?? 'desc'
  if (order !== 'asc' && order !== 'desc') {
    throw new ListParamError('order: asc or desc')
  }
  return { sort, order }
}

// The tasks in that order, those without a value last, and by repository and name when equal.
export function sortTasks(tasks: TaskStats[], { sort, order }: TaskOrder): TaskStats[] {
  const value = SORT_BY[sort]
  return [...tasks].sort((a, b) => {
    const x = value(a)
    const y = value(b)
    if (x === undefined || y === undefined) {
      return x === y ? tie(a, b) : x === undefined ? 1 : -1
    }
    const compared = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))
    return (order === 'asc' ? compared : -compared) || tie(a, b)
  })
}

const tie = (a: TaskStats, b: TaskStats) => a.repo.localeCompare(b.repo) || a.task.localeCompare(b.task)
