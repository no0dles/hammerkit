import type { StoredEvent } from './runs'

type LogEvent = Extract<StoredEvent, { type: 'log' }>

// what one call returns at most, and by default
export const MAX_LOG_LINES = 1000
const DEFAULT_LOG_LINES = 200
const MAX_CONTEXT = 20
const MAX_PATTERN = 200

/**
 * What a caller asks of the log of a run: the lines of some tasks, numbered from 1 over
 * that selection, then a fixed string to look for, then a window. A later call with the
 * same `task` and a `from` reads around a match.
 */
export interface LogQuery {
  tasks: string[]
  // the last lines of the selection (or of the matches)
  tail?: number
  // the first line to return, by its number
  from?: number
  limit: number
  // a fixed string, not a pattern: a regular expression of the caller could keep the
  // server busy for as long as it likes
  grep?: string
  ignoreCase: boolean
  // lines before and after a match
  context: number
}

export interface LogLine {
  line: number
  task: string
  stream: 'stdout' | 'stderr'
  text: string
  // with `grep`: false for a line of context
  match?: boolean
}

export interface LogPage {
  lines: LogLine[]
  // lines of the selection, before `grep`
  total: number
  // lines that contain `grep`
  matches?: number
  // the `from` that continues where this page stopped
  next?: number
  // the server cut the log of the run off at its limit, the end of it is not kept
  truncated: boolean
}

const PARAMETERS = ['task', 'tail', 'from', 'limit', 'grep', 'i', 'context']

function count(params: URLSearchParams, name: string, min: number, max: number): number | undefined {
  const value = params.get(name)
  if (value === null) {
    return undefined
  }
  if (!/^\d{1,9}$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${name} is a number from ${min} to ${max}`)
  }
  return Number(value)
}

// Reads the query of `GET /v1/runs/<id>/logs`; throws with what is wrong.
export function parseLogQuery(params: URLSearchParams): LogQuery {
  for (const name of new Set(params.keys())) {
    if (!PARAMETERS.includes(name)) {
      throw new Error(`there is no parameter ${name}, the log takes ${PARAMETERS.join(', ')}`)
    }
    if (name !== 'task' && params.getAll(name).length > 1) {
      throw new Error(`${name} is given more than once`)
    }
  }
  const tail = count(params, 'tail', 1, MAX_LOG_LINES)
  const from = count(params, 'from', 1, 999_999_999)
  if (tail !== undefined && from !== undefined) {
    throw new Error('tail and from do not go together, tail reads the end and from reads on from a line')
  }
  const grep = params.get('grep') ?? undefined
  if (grep !== undefined && (grep.length === 0 || grep.length > MAX_PATTERN)) {
    throw new Error(`grep is a text of 1 to ${MAX_PATTERN} characters`)
  }
  const i = params.get('i')
  if (i !== null && !['true', 'false', '1', '0'].includes(i)) {
    throw new Error('i is true or false')
  }
  return {
    tasks: params.getAll('task'),
    tail,
    from,
    limit: count(params, 'limit', 1, MAX_LOG_LINES) ?? DEFAULT_LOG_LINES,
    grep,
    ignoreCase: i === 'true' || i === '1',
    context: count(params, 'context', 0, MAX_CONTEXT) ?? 0,
  }
}

// The lines of the log events a query selects, see LogQuery.
export function readLogs(events: LogEvent[], query: LogQuery, truncated: boolean): LogPage {
  const all: LogLine[] = []
  for (const event of events) {
    if (query.tasks.length > 0 && !query.tasks.includes(event.task)) {
      continue
    }
    for (const text of event.text.replace(/\r?\n$/, '').split(/\r?\n/)) {
      all.push({ line: all.length + 1, task: event.task, stream: event.stream, text })
    }
  }

  let selected = all
  let matches: number | undefined
  if (query.grep !== undefined) {
    const needle = query.ignoreCase ? query.grep.toLowerCase() : query.grep
    const hit = all.map((line) => (query.ignoreCase ? line.text.toLowerCase() : line.text).includes(needle))
    matches = hit.filter(Boolean).length
    const shown = new Array<boolean>(all.length).fill(false)
    hit.forEach((found, index) => {
      if (found) {
        for (
          let near = Math.max(0, index - query.context);
          near <= Math.min(all.length - 1, index + query.context);
          near++
        ) {
          shown[near] = true
        }
      }
    })
    selected = all.filter((_, index) => shown[index]).map((line) => ({ ...line, match: hit[line.line - 1] }))
  }

  if (query.from !== undefined) {
    const from = query.from
    selected = selected.filter((line) => line.line >= from)
  }
  let lines: LogLine[]
  let next: number | undefined
  if (query.tail !== undefined) {
    lines = selected.slice(-Math.min(query.tail, query.limit))
  } else {
    lines = selected.slice(0, query.limit)
    next = selected.length > query.limit ? selected[query.limit].line : undefined
  }
  return {
    lines,
    total: all.length,
    ...(matches !== undefined ? { matches } : {}),
    ...(next !== undefined ? { next } : {}),
    truncated,
  }
}
