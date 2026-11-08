import { useEffect, useRef, useState } from 'react'
import { inputClass } from './ui'

/**
 * A span of time to read numbers over, chosen in one field: a period back from now, everything
 * the server keeps, or a range from one time to another (either end may be open).
 */
export type TimeRange =
  | { type: 'last'; period: string }
  | { type: 'all' }
  | { type: 'between'; from?: string; to?: string }

// the periods back from now, as `since` of the API takes them
export const PERIODS: [string, string][] = [
  ['1h', 'Last hour'],
  ['24h', 'Last 24 hours'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
]

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3600_000, d: 86400_000 }

function periodMs(period: string): number | undefined {
  const match = /^(\d+)([mhd])$/.exec(period)
  return match ? Number(match[1]) * UNIT_MS[match[2]] : undefined
}

// The range in the address of a page: `since=7d`, `since=` for all, or `from` and `to` (ISO)
export function readTimeRange(params: URLSearchParams, fallback: string): TimeRange {
  const from = params.get('from')
  const to = params.get('to')
  if (from !== null || to !== null) {
    return { type: 'between', ...(from ? { from } : {}), ...(to ? { to } : {}) }
  }
  const since = params.get('since')
  if (since === '') {
    return { type: 'all' }
  }
  return { type: 'last', period: since ?? fallback }
}

export function writeTimeRange(params: URLSearchParams, range: TimeRange, fallback: string): URLSearchParams {
  const next = new URLSearchParams(params)
  next.delete('since')
  next.delete('from')
  next.delete('to')
  if (range.type === 'all') {
    next.set('since', '')
  } else if (range.type === 'last' && range.period !== fallback) {
    next.set('since', range.period)
  } else if (range.type === 'between') {
    if (range.from) next.set('from', range.from)
    if (range.to) next.set('to', range.to)
  }
  return next
}

// `since` and `until` of the API for the range
export function timeRangeQuery(range: TimeRange): URLSearchParams {
  const query = new URLSearchParams()
  if (range.type === 'last') {
    query.set('since', range.period)
  } else if (range.type === 'between') {
    if (range.from) query.set('since', range.from)
    if (range.to) query.set('until', range.to)
  }
  return query
}

const short = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

// how a time shows in a datetime-local input, in the time zone of the browser
function toLocalInput(at: number | undefined): string {
  if (at === undefined || !Number.isFinite(at)) {
    return ''
  }
  const date = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`
}

function describe(range: TimeRange, oldest: string | undefined): string {
  if (range.type === 'last') {
    return PERIODS.find(([value]) => value === range.period)?.[1] ?? `Last ${range.period}`
  }
  if (range.type === 'all') {
    return oldest ? `All the server keeps, since ${short(oldest)}` : 'All the server keeps'
  }
  return `${range.from ? short(range.from) : 'the oldest run'} → ${range.to ? short(range.to) : 'now'}`
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4 shrink-0 fill-none stroke-current" strokeWidth="1.5">
      <rect x="2" y="3" width="12" height="11" rx="1.5" />
      <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" strokeLinecap="round" />
    </svg>
  )
}

/**
 * One field that shows the range and opens a panel to change it: the common periods with one
 * click, or a start and an end of one's own. `oldest` is when the oldest run counted was created.
 */
export function TimeRangePicker({
  value,
  onChange,
  oldest,
}: {
  value: TimeRange
  onChange: (range: TimeRange) => void
  oldest?: string
}) {
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !box.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])

  const toggle = () => {
    if (!open) {
      // the range of one's own starts as what is shown now
      const now = Date.now()
      const start =
        value.type === 'between'
          ? Date.parse(value.from ?? '')
          : value.type === 'last'
            ? now - (periodMs(value.period) ?? 0)
            : Date.parse(oldest ?? '')
      setFrom(toLocalInput(Number.isFinite(start) ? start : undefined))
      setTo(value.type === 'between' && value.to ? toLocalInput(Date.parse(value.to)) : '')
    }
    setOpen(!open)
  }
  const pick = (range: TimeRange) => {
    onChange(range)
    setOpen(false)
  }
  const fromAt = from ? new Date(from).getTime() : undefined
  // the inputs say minutes: the end takes its whole minute
  const toAt = to ? new Date(to).getTime() + 59_999 : undefined
  const backwards = fromAt !== undefined && toAt !== undefined && toAt < fromAt
  const apply = () =>
    pick(
      fromAt === undefined && toAt === undefined
        ? { type: 'all' }
        : {
            type: 'between',
            ...(fromAt !== undefined ? { from: new Date(fromAt).toISOString() } : {}),
            ...(toAt !== undefined ? { to: new Date(toAt).toISOString() } : {}),
          }
    )
  const chip = (active: boolean) =>
    `rounded-md px-2 py-1 text-left text-sm ${
      active
        ? 'bg-emerald-600 text-white dark:bg-emerald-500 dark:text-stone-950'
        : 'hover:bg-stone-100 dark:hover:bg-stone-800'
    }`

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Time range"
        className={`${inputClass} flex max-w-full items-center gap-2 text-left hover:border-stone-400 dark:hover:border-stone-500`}
      >
        <CalendarIcon />
        <span className="truncate">{describe(value, oldest)}</span>
        <span aria-hidden="true" className="ml-1 text-stone-400">
          ▾
        </span>
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Choose the time range"
          className="absolute right-0 z-20 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-stone-200 bg-white p-3 shadow-lg dark:border-stone-700 dark:bg-stone-900"
        >
          <p className="mb-1 text-xs font-medium text-stone-500 dark:text-stone-400">Commonly used</p>
          <div className="mb-3 grid grid-cols-2 gap-1">
            {PERIODS.map(([period, name]) => (
              <button
                key={period}
                type="button"
                className={chip(value.type === 'last' && value.period === period)}
                onClick={() => pick({ type: 'last', period })}
              >
                {name}
              </button>
            ))}
            <button
              type="button"
              className={`${chip(value.type === 'all')} col-span-2`}
              onClick={() => pick({ type: 'all' })}
            >
              All the server keeps
            </button>
          </div>
          <p className="mb-1 text-xs font-medium text-stone-500 dark:text-stone-400">From and to</p>
          <div className="flex flex-col gap-2">
            <label className="flex items-center justify-between gap-2 text-sm">
              <span className="w-10 text-stone-500 dark:text-stone-400">From</span>
              <input
                type="datetime-local"
                className={`${inputClass} flex-1`}
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label className="flex items-center justify-between gap-2 text-sm">
              <span className="w-10 text-stone-500 dark:text-stone-400">To</span>
              <input
                type="datetime-local"
                className={`${inputClass} flex-1`}
                value={to}
                onChange={(e) => setTo(e.target.value)}
                title="empty: up to now"
              />
            </label>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-stone-500 dark:text-stone-400">
                {backwards ? 'The end is before the start.' : 'An empty end is now.'}
              </span>
              <button
                type="button"
                disabled={backwards}
                onClick={apply}
                className="rounded-md bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50 dark:bg-emerald-500 dark:text-stone-950 dark:hover:bg-emerald-400"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
