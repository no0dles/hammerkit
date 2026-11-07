import { useEffect, useState, type ReactNode } from 'react'
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

export function Facts({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
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
  cached: 'text-emerald-700 border-emerald-600/40 bg-emerald-50 dark:text-emerald-300 dark:bg-emerald-950',
  failed: 'text-red-700 border-red-600/40 bg-red-50 dark:text-red-300 dark:bg-red-950',
  rejected: 'text-red-700 border-red-600/40 bg-red-50 dark:text-red-300 dark:bg-red-950',
  running: 'text-sky-700 border-sky-600/40 bg-sky-50 dark:text-sky-300 dark:bg-sky-950',
  queued: 'text-sky-700 border-sky-600/40 bg-sky-50 dark:text-sky-300 dark:bg-sky-950',
  asleep: 'text-amber-700 border-amber-600/40 bg-amber-50 dark:text-amber-300 dark:bg-amber-950',
  'awaiting-approval': 'text-amber-700 border-amber-600/40 bg-amber-50 dark:text-amber-300 dark:bg-amber-950',
  waiting: 'text-amber-700 border-amber-600/40 bg-amber-50 dark:text-amber-300 dark:bg-amber-950',
}

export function State({ state }: { state: string }) {
  return (
    <span
      className={`inline-block rounded-full border px-2 py-px text-xs font-medium whitespace-nowrap ${
        STATE_STYLES[state] ?? 'border-stone-300 text-stone-600 dark:border-stone-700 dark:text-stone-300'
      }`}
    >
      {state}
    </span>
  )
}

export function Time({ iso, now }: { iso: string | undefined; now: number }) {
  if (!iso || !Number.isFinite(Date.parse(iso))) {
    return null
  }
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {relative(iso, now)}
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

export function Owner({ run }: { run: { owner?: { sub: string } } }) {
  return run.owner ? (
    <span className="ml-1 text-xs text-stone-500 dark:text-stone-400">
      of <T>{run.owner.sub}</T>
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

export function Source({ run }: { run: Pick<Run, 'source'> }) {
  const source = run.source
  if (source.type === 'ref') {
    return (
      <span>
        <T>{source.repo}</T>
        <br />
        <span className="text-xs">
          <Code>{source.ref}</Code> at <Code>{source.commit.slice(0, 12)}</Code>
        </span>
      </span>
    )
  }
  if (source.type === 'sandbox') {
    return (
      <span>
        sandbox <Code>{source.id}</Code>
        <br />
        <span className="text-xs">
          <T>{source.repo}</T> at <Code>{source.commit.slice(0, 12)}</Code>
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
export function RunButtons({ run }: { run: Pick<ListedRun, 'id' | 'may'> }) {
  const [ttl, setTtl] = useState('8h')
  const stop = useAction(() => post(`/v1/runs/${encodeURIComponent(run.id)}/cancel`))
  const extend = useAction(() => post(`/v1/runs/${encodeURIComponent(run.id)}/extend`, { ttl }))
  if (!run.may?.stop && !run.may?.extend) {
    return null
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {run.may.extend ? (
        <span className="flex items-center gap-1">
          <select className={inputClass} value={ttl} onChange={(e) => setTtl(e.target.value)} aria-label="Keep it for">
            {EXTEND_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
          <Button onClick={() => extend.mutate()} disabled={extend.isPending}>
            Extend
          </Button>
        </span>
      ) : null}
      {run.may.stop ? (
        <Button
          tone="danger"
          onClick={() => {
            if (window.confirm(`Stop ${run.id}?`)) {
              stop.mutate()
            }
          }}
          disabled={stop.isPending}
        >
          Stop
        </Button>
      ) : null}
      {stop.error ? <ErrorNote error={stop.error} /> : null}
      {extend.error ? <ErrorNote error={extend.error} /> : null}
    </div>
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
export function Plan({ plan, args }: { plan: Record<string, TaskPlan>; args?: unknown }) {
  return (
    <div className="flex flex-col gap-3">
      {Array.isArray(args) && args.length > 0 ? (
        <p className="text-sm">
          Arguments:{' '}
          {args.map((arg, index) => (
            <Code key={index} className="mr-1">
              {JSON.stringify(arg)}
            </Code>
          ))}
        </p>
      ) : null}
      {Object.entries(plan).map(([name, entry]) => (
        <div key={name} className="text-sm">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <strong>
              <Code>{name}</Code>
            </strong>
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
              entry.deps.length > 0 ? `after ${entry.deps.join(', ')}` : '',
              entry.needs.length > 0 ? `needs ${entry.needs.join(', ')}` : '',
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
      ))}
    </div>
  )
}

export function Endpoints({ run }: { run: Pick<ListedRun, 'up'> }) {
  const endpoints = run.up?.endpoints ?? []
  if (endpoints.length === 0) {
    return <Quiet>none</Quiet>
  }
  return (
    <span className="flex flex-col">
      {endpoints.map((endpoint) =>
        endpoint.url && /^https?:\/\//.test(endpoint.url) ? (
          <a key={endpoint.url} className="link" href={endpoint.url} rel="noreferrer">
            <T>{`${endpoint.service}:${endpoint.port}`}</T>
          </a>
        ) : (
          <span key={`${endpoint.service}:${endpoint.port}`}>
            <T>{`${endpoint.service}:${endpoint.port}`}</T>
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
export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-stone-200 text-xs text-stone-500 dark:border-stone-800 dark:text-stone-400">
          <tr>
            {head.map((cell, index) => (
              <th key={index} className="px-3 py-2 font-medium whitespace-nowrap">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100 dark:divide-stone-800">{children}</tbody>
      </table>
    </div>
  )
}

export function Td({ children, num, className = '' }: { children?: ReactNode; num?: boolean; className?: string }) {
  return (
    <td className={`px-3 py-2 align-top ${num ? 'text-right whitespace-nowrap tabular-nums' : ''} ${className}`}>
      {children}
    </td>
  )
}
