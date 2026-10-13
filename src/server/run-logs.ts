import type { StoredEvent } from './runs'

// what one call returns at most, and by default
export const MAX_LOG_LINES = 1000
const DEFAULT_LOG_LINES = 200
const MAX_CONTEXT = 20
const MAX_PATTERN = 200

/**
 * What a caller asks of the log of a run: the lines of one task or of all, numbered from 1
 * over that selection, then a fixed string to look for, then a window. A later call with
 * the same `task` and a `from` reads around a match.
 */
export interface LogQuery {
  task?: string
  // the last lines of the selection (or of what `grep` selects)
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
    if (params.getAll(name).length > 1) {
      throw new Error(`${name} is given more than once`)
    }
  }
  const tail = count(params, 'tail', 1, MAX_LOG_LINES)
  const from = count(params, 'from', 1, 999_999_999)
  if (tail !== undefined && from !== undefined) {
    throw new Error('tail and from do not go together, tail reads the end and from reads on from a line')
  }
  const grep = params.get('grep') ?? undefined
  if (grep !== undefined && (grep.length === 0 || grep.length > MAX_PATTERN || /[\r\n]/.test(grep))) {
    throw new Error(`grep is a text of 1 to ${MAX_PATTERN} characters on one line`)
  }
  const i = params.get('i')
  if (i !== null && !['true', 'false', '1', '0'].includes(i)) {
    throw new Error('i is true or false')
  }
  const task = params.get('task') ?? undefined
  if (task === '') {
    throw new Error('task is the name of a task, leave it out for the lines of every task')
  }
  return {
    ...(task !== undefined ? { task } : {}),
    tail,
    from,
    // `tail=500` means 500 lines, unless a smaller limit says otherwise
    limit: count(params, 'limit', 1, MAX_LOG_LINES) ?? tail ?? DEFAULT_LOG_LINES,
    grep,
    ignoreCase: i === 'true' || i === '1',
    context: count(params, 'context', 0, MAX_CONTEXT) ?? 0,
  }
}

/**
 * Where the lines of a run's log are: built as the log grows, so a read costs the lines it
 * returns and not the whole log. A line is a range of the text of one log event, the line
 * break and a `\r` before it not included.
 */
export class LogIndex {
  // the events looked at so far
  private scanned = 0
  private readonly lineEvent: number[] = []
  private readonly lineStart: number[] = []
  private readonly lineEnd: number[] = []
  // per task, its lines by their index in the whole log
  private readonly taskLines = new Map<string, number[]>()
  // per log event, its first line and how many it has
  private readonly eventLines = new Map<number, [number, number]>()

  update(events: StoredEvent[]): void {
    for (; this.scanned < events.length; this.scanned++) {
      const event = events[this.scanned]
      if (event.type !== 'log') {
        continue
      }
      let lines = this.taskLines.get(event.task)
      if (!lines) {
        lines = []
        this.taskLines.set(event.task, lines)
      }
      const text = event.text
      const end = text.endsWith('\r\n') ? text.length - 2 : text.endsWith('\n') ? text.length - 1 : text.length
      const first = this.lineStart.length
      let start = 0
      for (;;) {
        const lineBreak = text.indexOf('\n', start)
        const stop = lineBreak < 0 || lineBreak >= end ? end : lineBreak
        this.lineEvent.push(this.scanned)
        this.lineStart.push(start)
        this.lineEnd.push(stop > start && text[stop - 1] === '\r' ? stop - 1 : stop)
        lines.push(this.lineStart.length - 1)
        if (stop >= end) {
          break
        }
        start = stop + 1
      }
      this.eventLines.set(this.scanned, [first, this.lineStart.length - first])
    }
  }

  get size(): number {
    return this.lineStart.length
  }

  lines(task: string): number[] {
    return this.taskLines.get(task) ?? []
  }

  text(events: StoredEvent[], line: number): { task: string; stream: 'stdout' | 'stderr'; text: string } {
    const event = events[this.lineEvent[line]] as Extract<StoredEvent, { type: 'log' }>
    return { task: event.task, stream: event.stream, text: event.text.slice(this.lineStart[line], this.lineEnd[line]) }
  }

  // The lines that contain `needle`, found per event so a line is not copied to be searched.
  matches(events: StoredEvent[], needle: string, ignoreCase: boolean): Uint8Array {
    const hits = new Uint8Array(this.size)
    // a literal pattern, so the search is linear; the `i` flag folds case without changing
    // where in the text a match is
    const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ignoreCase ? 'gi' : 'g')
    for (const [index, [first, length]] of this.eventLines) {
      const text = (events[index] as Extract<StoredEvent, { type: 'log' }>).text
      pattern.lastIndex = 0
      let line = first
      let found: RegExpExecArray | null
      while ((found = pattern.exec(text)) !== null) {
        while (line < first + length - 1 && this.lineEnd[line] < found.index + needle.length) {
          line++
        }
        if (this.lineEnd[line] < found.index + needle.length) {
          break
        }
        hits[line] = 1
        // one hit per line is enough
        pattern.lastIndex = this.lineEnd[line] + 1
      }
    }
    return hits
  }
}

// The lines of the log a query selects, see LogQuery.
export function readLogs(events: StoredEvent[], index: LogIndex, query: LogQuery, truncated: boolean): LogPage {
  const selected = query.task !== undefined ? index.lines(query.task) : undefined
  const total = selected ? selected.length : index.size
  const at = (position: number) => (selected ? selected[position] : position)
  const hits = query.grep !== undefined ? index.matches(events, query.grep, query.ignoreCase) : undefined
  const toLine = (position: number): LogLine => ({
    line: position + 1,
    ...index.text(events, at(position)),
    ...(hits ? { match: hits[at(position)] === 1 } : {}),
  })

  // the positions of the selection to answer, in order
  const positions: number[] = []
  const want = query.tail !== undefined ? Math.min(query.tail, query.limit) : query.limit
  let next: number | undefined
  if (!hits) {
    if (query.tail !== undefined) {
      for (let position = Math.max(0, total - want); position < total; position++) {
        positions.push(position)
      }
    } else {
      const start = (query.from ?? 1) - 1
      for (let position = start; position < Math.min(total, start + query.limit); position++) {
        positions.push(position)
      }
      next = start + query.limit < total ? start + query.limit + 1 : undefined
    }
  } else if (query.tail !== undefined) {
    // from the end: the last matches with the lines around them
    let lowest = total
    for (let position = total - 1; position >= 0 && positions.length < want; position--) {
      if (hits[at(position)] !== 1) {
        continue
      }
      const high = Math.min(total - 1, position + query.context, lowest - 1)
      for (let near = high; near >= Math.max(0, position - query.context) && positions.length < want; near--) {
        positions.push(near)
        lowest = near
      }
    }
    positions.reverse()
  } else {
    const start = (query.from ?? 1) - 1
    // a match just before `from` still shows the lines after it
    let emitted = start - 1
    for (let position = Math.max(0, start - query.context); position < total; position++) {
      if (hits[at(position)] !== 1) {
        continue
      }
      const high = Math.min(total - 1, position + query.context)
      for (let near = Math.max(emitted + 1, position - query.context); near <= high; near++) {
        if (positions.length === query.limit) {
          next = near + 1
          break
        }
        positions.push(near)
        emitted = near
      }
      if (next !== undefined) {
        break
      }
    }
  }

  return {
    lines: positions.map(toLine),
    total,
    ...(next !== undefined ? { next } : {}),
    truncated,
  }
}
