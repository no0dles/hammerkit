import { useEffect, useId, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { webLinks } from '../../src/utils/web-links'
import { Link } from 'react-router'
import type { UseQueryResult } from '@tanstack/react-query'
import {
  ApiError,
  post,
  signInPath,
  useAction,
  useSession,
  type ListedRun,
  type Meter as MeterData,
  type TaskPlan,
} from './api'
import { cut, formatDuration, printable, relative } from './format'
import type { Run } from '../../src/server/runs'

// The time of the page, moved on every few seconds: "2m ago" stays true.
export function useNow(ms = 5000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}

// A text of a run, a build file or a person: React escapes it, control and bidi characters
// are shown as `?`.
export function T({ children }: { children: string | undefined }) {
  return <>{printable(children ?? '')}</>
}

export function Code({ children, className = '' }: { children: string; className?: string }) {
  return (
    <code className={`font-mono text-[0.85em] break-all ${className}`}>
      <T>{children}</T>
    </code>
  )
}

export function Quiet({ children }: { children: ReactNode }) {
  return <span className="text-stone-500 dark:text-stone-400">{children}</span>
}

export function PageTitle({ children, note }: { children: string; note?: ReactNode }) {
  useEffect(() => {
    document.title = `${printable(children)} · hammerkit`
  }, [children])
  return (
    <div className="mb-6 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h1 className="text-2xl font-semibold tracking-tight break-all">
        <T>{children}</T>
      </h1>
      {note ? <p className="text-sm text-stone-500 dark:text-stone-400">{note}</p> : null}
    </div>
  )
}

export function Section({
  title,
  note,
  children,
  id,
}: {
  title: ReactNode
  note?: ReactNode
  children: ReactNode
  id?: string
}) {
  return (
    <section className="mb-8" id={id}>
      <h2 className="mb-3 flex flex-wrap items-baseline gap-x-2 text-base font-semibold">
        {title}
        {note ? <span className="text-sm font-normal text-stone-500 dark:text-stone-400">{note}</span> : null}
      </h2>
      {children}
    </section>
  )
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-lg border border-stone-200 bg-white p-4 shadow-xs dark:border-stone-800 dark:bg-stone-900 ${className}`}
    >
      {children}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-stone-500 dark:text-stone-400">{children}</p>
}

// names and their values; `columns` sets how wide the names are, by default as wide as the widest
export function Facts({
  items,
  columns = 'grid-cols-[max-content_1fr]',
}: {
  items: [ReactNode, ReactNode][]
  columns?: string
}) {
  return (
    <dl className={`grid ${columns} gap-x-4 gap-y-1.5 text-sm`}>
      {items.map(([name, value], index) => (
        <div key={index} className="contents">
          <dt className="text-stone-500 dark:text-stone-400">{name}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

const STATE_STYLES: Record<string, string> = {
  up: 'text-emerald-700 border-emerald-600/40 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950',
  succeeded: 'text-emerald-700 border-emerald-600/40 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950',
  approved: 'text-emerald-700 border-emerald-600/40 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950',
  published: 'text-emerald-700 border-emerald-600/40 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950',
  cached: 'text-emerald-700 border-emerald-600/40 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950',
  failed: 'text-red-700 border-red-600/40 bg-red-50 dark:text-red-300 dark:bg-red-950',
  rejected: 'text-red-700 border-red-600/40 bg-red-50 dark:text-red-300 dark:bg-red-950',
  running: 'text-sky-700 border-sky-600/40 bg-sky-50 dark:text-sky-300 dark:bg-sky-950',
  queued: 'text-sky-700 border-sky-600/40 bg-sky-50 dark:text-sky-300 dark:bg-sky-950',
  asleep: 'text-amber-700 border-amber-600/40 bg-amber-50 dark:text-amber-300 dark:bg-amber-950',
  'awaiting-approval': 'text-amber-700 border-amber-600/40 bg-amber-50 dark:text-amber-300 dark:bg-amber-950',
  waiting: 'text-amber-700 border-amber-600/40 bg-amber-50 dark:text-amber-300 dark:bg-amber-950',
}

// the mark inside the round state, drawn on 16 by 16
const CHECK = <path d="M4.75 8.25l2.25 2.25 4.25-4.5" />
const CROSS = <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" />
const PAUSE = <path d="M6.5 5.5v5M9.5 5.5v5" />
const STATE_MARKS: Record<string, ReactNode> = {
  succeeded: CHECK,
  approved: CHECK,
  // a bolt: done before, so it took no time
  cached: <path d="M8.75 3.75L5.25 8.75h3l-1 3.5 3.5-5h-3z" className="fill-current" strokeWidth="1" />,
  failed: CROSS,
  rejected: CROSS,
  cancelled: <path d="M5 8h6" />,
  published: CHECK,
  // pulled back: no run starts from it
  yanked: <path d="M5 8h6" />,
  skipped: <path d="M5.5 5.25L8.5 8l-3 2.75M10.5 5.25v5.5" />,
  running: <path d="M8 4a4 4 0 0 1 4 4" className="origin-center animate-spin" />,
  up: <circle cx="8" cy="8" r="2.25" className="fill-current stroke-none" />,
  queued: (
    <g className="fill-current stroke-none">
      <circle cx="5" cy="8" r="1" />
      <circle cx="8" cy="8" r="1" />
      <circle cx="11" cy="8" r="1" />
    </g>
  ),
  asleep: <path d="M10.75 9.5A3.5 3.5 0 0 1 6.5 5.25a3.5 3.5 0 1 0 4.25 4.25z" />,
  'awaiting-approval': PAUSE,
  waiting: PAUSE,
  // the hands of a clock: its time ran out
  expired: <path d="M8 5v3l2 1.5" />,
}

// A round mark of the same width for every state, without its name: for beside the name.
export function StateMark({ state }: { state: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border align-middle ${
        STATE_STYLES[state] ?? 'border-stone-300 text-stone-600 dark:border-stone-700 dark:text-stone-300'
      }`}
    >
      <svg
        viewBox="0 0 16 16"
        className="h-4 w-4 fill-none stroke-current"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {STATE_MARKS[state] ?? <circle cx="8" cy="8" r="1.25" className="fill-current stroke-none" />}
      </svg>
    </span>
  )
}

/**
 * The state as its round mark alone, for a column of states: the name shows on hover and is what
 * a screen reader says. `detail` adds to it, such as the place in the queue.
 */
export function StateIcon({ state, detail }: { state: string; detail?: string }) {
  const label = detail ? `${state}, ${detail}` : state
  return (
    <span role="img" aria-label={label} title={label} className="inline-flex align-middle">
      <StateMark state={state} />
    </span>
  )
}

// The state as its round mark with its name beside it, where it stands on its own.
export function State({ state }: { state: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 align-middle whitespace-nowrap">
      <StateMark state={state} />
      {state}
    </span>
  )
}

/**
 * `children` with `tip` beside it while the pointer is on them or they have the focus. The tip
 * floats over the page, so a table that scrolls does not cut it off.
 */
export function Tip({ tip, children }: { tip: ReactNode; children: ReactNode }) {
  const id = useId()
  const [at, setAt] = useState<DOMRect | null>(null)
  useEffect(() => {
    if (!at) {
      return
    }
    // it stays where it was put: gone once the page moves
    const hide = () => setAt(null)
    window.addEventListener('scroll', hide, true)
    return () => window.removeEventListener('scroll', hide, true)
  }, [at])
  const show = (event: { currentTarget: HTMLElement }) => setAt(event.currentTarget.getBoundingClientRect())
  return (
    <span
      tabIndex={0}
      aria-describedby={at ? id : undefined}
      onMouseEnter={show}
      onFocus={show}
      onMouseLeave={() => setAt(null)}
      onBlur={() => setAt(null)}
      className="cursor-default underline decoration-stone-400/70 decoration-dotted underline-offset-4 outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-emerald-500 dark:decoration-stone-500/70"
    >
      {children}
      {at
        ? createPortal(
            <div
              id={id}
              role="tooltip"
              style={{ top: at.bottom + 6, left: at.right }}
              className="pointer-events-none fixed z-50 -translate-x-full rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-left text-xs whitespace-nowrap text-stone-700 shadow-lg dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200"
            >
              {tip}
            </div>,
            document.body
          )
        : null}
    </span>
  )
}

// A date and time, with how long ago (or until when) it is on hover. The year shows when it is not this one.
export function Time({ iso, now }: { iso: string | undefined; now: number }) {
  if (!iso || !Number.isFinite(Date.parse(iso))) {
    return null
  }
  const date = new Date(iso)
  const at = date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })
  return (
    <time dateTime={iso} title={relative(iso, now)}>
      {at}
    </time>
  )
}

// how much of something is taken: `value` of `max`, with a lighter mark for `also`
export function Bar({ value, max, also, full }: { value?: number; max?: number; also?: number; full?: boolean }) {
  const share = (n: number | undefined) => (max && n !== undefined ? Math.min(100, (n / max) * 100) : 0)
  return (
    <div className="relative h-2 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-800">
      {also !== undefined ? (
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-emerald-600/30 dark:bg-emerald-400/30"
          style={{ width: `${share(also)}%` }}
        />
      ) : null}
      <div
        className={`absolute inset-y-0 left-0 rounded-full ${
          full ? 'bg-amber-500' : 'bg-emerald-600 dark:bg-emerald-500'
        }`}
        style={{ width: `${share(value)}%` }}
      />
    </div>
  )
}

// One of the caller's limits: how many count against it, and which runs
export function Meter({ name, meter, setting }: { name: string; meter: MeterData; setting: string }) {
  const full = meter.limit !== undefined && meter.used >= meter.limit
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <strong className={`text-sm ${full ? 'text-amber-600 dark:text-amber-400' : ''}`}>{name}</strong>
        <span className="text-sm whitespace-nowrap tabular-nums">
          {meter.used}
          {meter.limit !== undefined ? <Quiet> of {meter.limit}</Quiet> : null}
        </span>
      </div>
      <Bar value={meter.used} max={meter.limit} full={full} />
      <div className="text-xs">
        {meter.runs.length > 0 ? (
          meter.runs.map((id, index) => (
            <span key={id}>
              {index > 0 ? ', ' : ''}
              <RunLink id={id} />
            </span>
          ))
        ) : (
          <Quiet>none</Quiet>
        )}
      </div>
      <div className="font-mono text-[0.7rem] text-stone-400 dark:text-stone-500">{setting}</div>
    </Card>
  )
}

export function RunLink({ id, children }: { id: string; children?: ReactNode }) {
  return (
    <Link to={`/runs/${encodeURIComponent(id)}`} className="link font-mono text-[0.85em]">
      {children ?? printable(id)}
    </Link>
  )
}

// A person as the pages name them: the name of their sign-in, else its subject, with the subject on hover.
export function Person({ who }: { who: { iss?: string; sub: string; name?: string } }) {
  return (
    <span title={who.name ? `${who.sub}${who.iss ? ` at ${who.iss}` : ''}` : who.iss}>
      <T>{who.name ?? who.sub}</T>
    </span>
  )
}

export function Owner({ run }: { run: { owner?: { iss?: string; sub: string; name?: string } } }) {
  return run.owner ? (
    <span className="ml-1 text-xs text-stone-500 dark:text-stone-400">
      of <Person who={run.owner} />
    </span>
  ) : null
}

// what a run does: its tasks, or the services it brings up
export function Work({ run }: { run: Pick<ListedRun, 'tasks' | 'up'> }) {
  if (run.up) {
    return (
      <span>
        <Code>{run.up.name}</Code>: up <T>{run.up.services.join(', ')}</T>
      </span>
    )
  }
  return run.tasks.length > 0 ? <T>{run.tasks.join(', ')}</T> : <Quiet>by labels</Quiet>
}

// A page of another site, such as the repository on GitHub: in a tab of its own.
export function WebLink({ href, children }: { href: string | undefined; children: ReactNode }) {
  if (!href) {
    return <>{children}</>
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="underline decoration-stone-400/40 underline-offset-2 hover:decoration-current dark:decoration-stone-500/50"
    >
      {children}
    </a>
  )
}

// A repository, a branch of it and a commit, each linked to where the forge shows it.
export function RepoAt({ repo, gitRef, commit }: { repo: string; gitRef?: string; commit?: string }) {
  const links = webLinks(repo)
  return (
    <>
      <WebLink href={links?.repo}>
        <T>{repo}</T>
      </WebLink>
      {gitRef || commit ? <br /> : null}
      <span className="text-xs">
        {gitRef ? (
          <WebLink href={links?.ref?.(gitRef)}>
            <Code>{gitRef}</Code>
          </WebLink>
        ) : null}
        {gitRef && commit ? ' at ' : null}
        {commit ? (
          <WebLink href={links?.commit?.(commit)}>
            <Code>{commit.slice(0, 12)}</Code>
          </WebLink>
        ) : null}
      </span>
    </>
  )
}

export function Source({ run }: { run: Pick<Run, 'source'> }) {
  const source = run.source
  if (source.type === 'ref') {
    return (
      <span>
        <RepoAt repo={source.repo} gitRef={source.ref} commit={source.commit} />
      </span>
    )
  }
  if (source.type === 'sandbox') {
    const links = webLinks(source.repo)
    return (
      <span>
        sandbox <Code>{source.id}</Code>
        <br />
        <span className="text-xs">
          <WebLink href={links?.repo}>
            <T>{source.repo}</T>
          </WebLink>{' '}
          at{' '}
          <WebLink href={links?.commit?.(source.commit)}>
            <Code>{source.commit.slice(0, 12)}</Code>
          </WebLink>
          {source.clean === false ? ' with changes' : ''}
        </span>
      </span>
    )
  }
  return <span>an upload</span>
}

export function Loading<T>({
  query,
  children,
  missing,
}: {
  query: UseQueryResult<T>
  children: (data: T) => ReactNode
  missing?: ReactNode
}) {
  if (query.isPending) {
    return <Empty>Loading…</Empty>
  }
  if (query.isError) {
    const error = query.error
    if (error instanceof ApiError && error.status === 404 && missing) {
      return <>{missing}</>
    }
    return <ErrorNote error={error} />
  }
  return <>{children(query.data)}</>
}

export function ErrorNote({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.signInAgain) {
    return (
      <p className="text-sm text-red-700 dark:text-red-400">
        {printable(error.message)}.{' '}
        <a className="link" href={signInPath()}>
          Sign in again
        </a>{' '}
        to decide.
      </p>
    )
  }
  return (
    <p className="text-sm text-red-700 dark:text-red-400">
      {printable(error instanceof Error ? error.message : String(error))}
    </p>
  )
}

export function Button({
  children,
  tone = 'plain',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'plain' | 'good' | 'danger' }) {
  const tones = {
    plain:
      'border-stone-300 bg-white hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-900 dark:hover:bg-stone-800',
    good: 'border-emerald-700 bg-emerald-600 text-white hover:bg-emerald-700',
    danger:
      'border-red-300 bg-white text-red-700 hover:bg-red-50 dark:border-red-900 dark:bg-stone-900 dark:text-red-400 dark:hover:bg-red-950',
  }
  return (
    <button
      {...props}
      className={`rounded-md border px-3 py-1 text-sm font-medium disabled:opacity-50 ${tones[tone]} ${
        props.className ?? ''
      }`}
    >
      {children}
    </button>
  )
}

export const inputClass =
  'rounded-md border border-stone-300 bg-white px-2 py-1 text-sm dark:border-stone-700 dark:bg-stone-900'

const EXTEND_CHOICES = ['1h', '8h', '24h', '72h']

// Stop a run, extend a service run: what the caller may, as the API says (`may`)
const iconButton =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border align-middle disabled:opacity-50'

// Stops a run, once asked whether to: a square, as on a player.
export function StopButton({ run }: { run: Pick<ListedRun, 'id' | 'may'> }) {
  const stop = useAction(() => post(`/v1/runs/${encodeURIComponent(run.id)}/cancel`))
  if (!run.may?.stop) {
    return null
  }
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        title="Stop"
        aria-label={`Stop ${run.id}`}
        disabled={stop.isPending}
        onClick={() => {
          if (window.confirm(`Stop ${run.id}?`)) {
            stop.mutate()
          }
        }}
        className={`${iconButton} border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950`}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5 fill-current">
          <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
        </svg>
      </button>
      {stop.error ? <ErrorNote error={stop.error} /> : null}
    </span>
  )
}

// Wakes a service run that sleeps, as a request to one of its endpoints would: a triangle, as on a player.
export function StartButton({ run }: { run: Pick<ListedRun, 'id' | 'may'> }) {
  const wake = useAction(() => post(`/v1/runs/${encodeURIComponent(run.id)}/wake`))
  if (!run.may?.wake) {
    return null
  }
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        title="Start"
        aria-label={`Start ${run.id}`}
        disabled={wake.isPending}
        onClick={() => wake.mutate()}
        className={`${iconButton} border-emerald-600/50 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-700 dark:text-emerald-400 dark:hover:bg-emerald-950`}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5 fill-current">
          <path d="M5 3.25v9.5a.75.75 0 0 0 1.14.64l7.5-4.75a.75.75 0 0 0 0-1.28l-7.5-4.75A.75.75 0 0 0 5 3.25z" />
        </svg>
      </button>
      {wake.error ? <ErrorNote error={wake.error} /> : null}
    </span>
  )
}

/**
 * Keeps a service run up for longer: a clock with a plus, which opens the choices of how long.
 * The choices float over the page, so a table that scrolls does not cut them off.
 */
export function ExtendButton({ run }: { run: Pick<ListedRun, 'id' | 'may'> }) {
  const extend = useAction((ttl: string) => post(`/v1/runs/${encodeURIComponent(run.id)}/extend`, { ttl }))
  const [at, setAt] = useState<DOMRect | null>(null)
  const id = useId()
  useEffect(() => {
    if (!at) {
      return
    }
    const close = (event: Event) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === 'Escape'
          : !(event.target as Element).closest?.(`[data-menu="${id}"]`)
      ) {
        setAt(null)
      }
    }
    const hide = () => setAt(null)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    window.addEventListener('scroll', hide, true)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
      window.removeEventListener('scroll', hide, true)
    }
  }, [at, id])
  if (!run.may?.extend) {
    return null
  }
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        data-menu={id}
        title="Extend"
        aria-label={`Extend ${run.id}`}
        aria-haspopup="menu"
        aria-expanded={!!at}
        disabled={extend.isPending}
        onClick={(event) => setAt(at ? null : event.currentTarget.getBoundingClientRect())}
        className={`${iconButton} border-stone-300 hover:bg-stone-50 dark:border-stone-700 dark:hover:bg-stone-800`}
      >
        <svg
          viewBox="0 0 16 16"
          aria-hidden="true"
          className="h-4 w-4 fill-none stroke-current"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <path d="M12.5 8.5a5 5 0 1 1-4-4.9M7.5 6v3l2 1.25M12.5 1.5v4M10.5 3.5h4" />
        </svg>
      </button>
      {at
        ? createPortal(
            <div
              role="menu"
              data-menu={id}
              aria-label="Keep it up for"
              style={{ top: at.bottom + 4, left: at.left }}
              className="fixed z-50 flex flex-col rounded-md border border-stone-200 bg-white py-1 text-sm shadow-lg dark:border-stone-700 dark:bg-stone-800"
            >
              <span className="px-3 py-1 text-xs text-stone-500 dark:text-stone-400">Keep it up for</span>
              {EXTEND_CHOICES.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  role="menuitem"
                  className="px-3 py-1 text-left hover:bg-stone-100 dark:hover:bg-stone-700"
                  onClick={() => {
                    setAt(null)
                    extend.mutate(choice)
                  }}
                >
                  {choice}
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
      {extend.error ? <ErrorNote error={extend.error} /> : null}
    </span>
  )
}

// Approve or reject a run or a version: a sign-in of the last minutes decides.
export function Decide({ path, yes, onDone }: { path: string; yes: string; onDone?: () => void }) {
  const session = useSession()
  const now = useNow()
  const [reason, setReason] = useState('')
  const decide = useAction((verb: 'approve' | 'reject') =>
    post(`${path}/${verb}`, verb === 'reject' && reason.trim() ? { reason: reason.trim().slice(0, 500) } : {})
  )
  const until = session.data?.decideUntil
  if (until && Date.parse(until) < now) {
    return (
      <p className="text-sm text-stone-500 dark:text-stone-400">
        Your sign-in is older than {session.data?.decideWithinMinutes} minutes.{' '}
        <a className="link" href={signInPath()}>
          Sign in again
        </a>{' '}
        to decide.
      </p>
    )
  }
  if (decide.isSuccess) {
    return <Empty>Done.</Empty>
  }
  const run = (verb: 'approve' | 'reject') => decide.mutate(verb, { onSuccess: () => onDone?.() })
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button tone="good" onClick={() => run('approve')} disabled={decide.isPending}>
          {yes}
        </Button>
        <input
          className={`${inputClass} min-w-0 flex-1 sm:max-w-xs`}
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          placeholder="why not (optional)"
          aria-label="Why not"
        />
        <Button tone="danger" onClick={() => run('reject')} disabled={decide.isPending}>
          Reject
        </Button>
      </div>
      {decide.error ? <ErrorNote error={decide.error} /> : null}
    </div>
  )
}

// what each task and service of a plan does, never a secret's value
// The arguments a run passes to the last command of its tasks.
export function Arguments({ args }: { args?: unknown }) {
  return Array.isArray(args) && args.length > 0 ? (
    <p className="text-sm">
      Arguments:{' '}
      {args.map((arg, index) => (
        <Code key={index} className="mr-1">
          {JSON.stringify(arg)}
        </Code>
      ))}
    </p>
  ) : null
}

// What one task or service does: where it runs, its commands, what it needs and reads. `name`
// heads it where nothing else says which it is.
// `relations` false leaves out what it runs after and needs, where that shows already.
export function PlanEntry({ name, entry, relations = true }: { name?: string; entry: TaskPlan; relations?: boolean }) {
  return (
    <div className="text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2">
        {name ? (
          <strong>
            <Code>{name}</Code>
          </strong>
        ) : null}
        <Quiet>
          {entry.kind}, {entry.runtime}
        </Quiet>
        {entry.image ? <Code className="text-stone-500">{entry.image}</Code> : null}
        {entry.flags.length > 0 ? (
          <span className="text-xs font-medium text-amber-600 dark:text-amber-400">{entry.flags.join(', ')}</span>
        ) : null}
      </div>
      {entry.description ? (
        <div className="text-xs">
          <T>{entry.description}</T>
        </div>
      ) : null}
      {entry.cmds.length > 0 ? (
        <pre className="log my-1">{entry.cmds.map((cmd) => `$ ${printable(cmd)}`).join('\n')}</pre>
      ) : null}
      <div className="text-xs text-stone-500 dark:text-stone-400">
        {[
          relations && entry.deps.length > 0 ? `after ${entry.deps.join(', ')}` : '',
          relations && entry.needs.length > 0 ? `needs ${entry.needs.join(', ')}` : '',
          ...entry.secrets.map(
            (secret) => `secret ${secret.from}${secret.account ? ` as ${secret.account}` : ''} → ${secret.target}`
          ),
          entry.mounts.length > 0 ? `mounts ${entry.mounts.join(', ')}` : '',
          entry.ports.length > 0 ? `ports ${entry.ports.join(', ')}` : '',
          entry.capAdd?.length ? `capAdd ${entry.capAdd.join(', ')}` : '',
        ]
          .filter(Boolean)
          .map(printable)
          .join(' · ')}
      </div>
    </div>
  )
}

export function Plan({ plan, args }: { plan: Record<string, TaskPlan>; args?: unknown }) {
  return (
    <div className="flex flex-col gap-3">
      <Arguments args={args} />
      {Object.entries(plan).map(([name, entry]) => (
        <PlanEntry key={name} name={name} entry={entry} />
      ))}
    </div>
  )
}

export function Endpoints({ run }: { run: Pick<ListedRun, 'up'> }) {
  const endpoints = run.up?.endpoints ?? []
  if (endpoints.length === 0) {
    return <Quiet>none</Quiet>
  }
  // by the name of the service, with the port only for a service of more than one
  const label = (endpoint: (typeof endpoints)[number]) =>
    endpoints.filter((other) => other.service === endpoint.service).length > 1
      ? `${endpoint.service}:${endpoint.port}`
      : endpoint.service
  return (
    <span className="flex flex-col">
      {endpoints.map((endpoint) =>
        endpoint.url && /^https?:\/\//.test(endpoint.url) ? (
          <a
            key={endpoint.url}
            className="link"
            href={endpoint.url}
            rel="noreferrer"
            title={`${endpoint.service}:${endpoint.port}`}
          >
            <T>{label(endpoint)}</T>
          </a>
        ) : (
          <span key={`${endpoint.service}:${endpoint.port}`} title={`${endpoint.service}:${endpoint.port}`}>
            <T>{label(endpoint)}</T>
          </span>
        )
      )}
    </span>
  )
}

export function Sleeps({ run, now }: { run: ListedRun; now: number }) {
  if (run.state === 'up' && run.sleepsAt) {
    return <Time iso={run.sleepsAt} now={now} />
  }
  return run.up?.sleepTtl ? <span>after {formatDuration(run.up.sleepTtl)}</span> : <Quiet>never</Quiet>
}

export { cut }

// A table that scrolls sideways on a narrow screen rather than the page.
export function Table<K extends string = string>({
  head,
  children,
  sort,
  right,
}: {
  head: ReactNode[]
  children: ReactNode
  // the columns a click sorts by (useSort), by their place in `head`; none for a column left out
  sort?: Sorting<K>
  // the heads to align right, over numbers and times (Td num), by their place in `head`
  right?: boolean[]
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-stone-200 text-xs text-stone-500 dark:border-stone-800 dark:text-stone-400">
          <tr>
            {head.map((cell, index) => {
              const key = sort?.keys[index]
              const active = !!sort && key !== undefined && sort.state.key === key
              const end = !!right?.[index]
              // the arrow on the side away from the values, so the name lines up with them
              const arrow = (
                <span aria-hidden="true" className={active ? '' : 'invisible'}>
                  {active && sort?.state.dir === 'asc' ? '↑' : '↓'}
                </span>
              )
              return (
                <th
                  key={index}
                  className={`px-3 py-2 font-medium whitespace-nowrap ${end ? 'text-right' : ''}`}
                  aria-sort={active ? (sort.state.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {sort && key !== undefined ? (
                    <button
                      type="button"
                      onClick={() => sort.onSort(key)}
                      className={`inline-flex cursor-pointer items-center gap-1 hover:text-stone-900 dark:hover:text-white ${
                        active ? 'text-stone-900 dark:text-white' : ''
                      }`}
                    >
                      {end ? arrow : null}
                      {cell}
                      {end ? null : arrow}
                    </button>
                  ) : (
                    cell
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100 dark:divide-stone-800">{children}</tbody>
      </table>
    </div>
  )
}

export interface SortState<K extends string> {
  key: K
  dir: 'asc' | 'desc'
}

export interface Sorting<K extends string> {
  keys: (K | undefined)[]
  state: SortState<K>
  onSort: (key: K) => void
}

/**
 * Rows sorted by the column a person clicked: a second click on it turns the order around.
 * Text sorts A to Z first, numbers the largest first; a row without a value is last either
 * way, and rows of the same value keep the order they came in.
 */
export function useSort<T, K extends string>(
  rows: T[],
  values: Record<K, (row: T) => string | number | undefined>,
  initial: SortState<NoInfer<K>>
): { rows: T[]; state: SortState<K>; onSort: (key: K) => void } {
  const [state, setState] = useState(initial)
  const value = values[state.key]
  const sorted = [...rows].sort((a, b) => {
    const x = value(a)
    const y = value(b)
    if (x === undefined || y === undefined) {
      return x === y ? 0 : x === undefined ? 1 : -1
    }
    const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))
    return state.dir === 'asc' ? order : -order
  })
  const onSort = (key: K) =>
    setState((current) => {
      if (current.key === key) {
        return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
      }
      const numeric = rows.some((row) => typeof values[key](row) === 'number')
      return { key, dir: numeric ? 'desc' : 'asc' }
    })
  return { rows: sorted, state, onSort }
}

export function Td({ children, num, className = '' }: { children?: ReactNode; num?: boolean; className?: string }) {
  return (
    <td className={`px-3 py-2 align-top ${num ? 'text-right whitespace-nowrap tabular-nums' : ''} ${className}`}>
      {children}
    </td>
  )
}
