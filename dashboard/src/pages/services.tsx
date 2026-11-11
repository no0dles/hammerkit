import { Fragment } from 'react'
import { useSearchParams } from 'react-router'
import { useApi, type ListedRun } from '../api'
import { webLinks } from '../../../src/utils/web-links'
import { relative } from '../format'
import { BuildFileLink } from './build-file'
import { countOptions, FilterPill, readChosen, writeChosen } from '../filter-pill'
import {
  Code,
  Empty,
  inputClass,
  Loading,
  PageTitle,
  Person,
  Quiet,
  ExtendButton,
  StartButton,
  StopButton,
  RunLink,
  Sleeps,
  StateIcon,
  T,
  Table,
  Tip,
  Td,
  Time,
  useNow,
  WebLink,
} from '../ui'

const DAY = 24 * 60 * 60 * 1000
const FINAL = ['succeeded', 'failed', 'cancelled', 'rejected']

// a service run's state in a word: starting until its services are up, ended once they went down
// as they should
export const serviceState = (run: ListedRun) =>
  ['awaiting-approval', 'queued', 'running'].includes(run.state)
    ? 'starting'
    : run.state === 'succeeded'
      ? 'ended'
      : run.state
// the order of those, from starting to over
const STATES = ['starting', 'up', 'asleep', 'ended', 'failed', 'cancelled', 'rejected']

type FilterKey = 'state' | 'source' | 'user'

// what a service run can be narrowed by, as the address names it, and the values a run has for it
const FILTERS: [FilterKey, string, (run: ListedRun) => string[], string[]?][] = [
  ['state', 'State', (run) => [serviceState(run)], STATES],
  ['source', 'Source', (run) => [repoOf(run)]],
  // the caller's own runs name no owner
  ['user', 'User', (run) => [run.owner ? run.owner.name ?? run.owner.sub : 'you']],
]

function matchesText(run: ListedRun, needle: string): boolean {
  const haystack = [
    run.id,
    run.owner?.sub ?? '',
    run.owner?.name ?? '',
    ...(run.up ? [run.up.name, ...run.up.services] : []),
    repoOf(run),
    run.source.type === 'ref' ? run.source.ref : '',
    run.entry ?? '',
  ]
  return haystack.some((value) => value.toLowerCase().includes(needle))
}

// The service runs that are starting, up or asleep, and those that ended in the last day, in that
// order, narrowed by text and filters.
export function ServicesPage() {
  const [params, setParams] = useSearchParams()
  const text = (params.get('q') ?? '').slice(0, 100)
  const query = useApi<{ runs: ListedRun[] }>('/runs?scope=visible&kind=services')
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
  const listed = (query.data?.runs ?? [])
    .filter((run) => !FINAL.includes(run.state) || now - Date.parse(run.finishedAt ?? run.createdAt) < DAY)
    .map((run, index) => ({ run, index }))
    .sort((a, b) => STATES.indexOf(serviceState(a.run)) - STATES.indexOf(serviceState(b.run)) || a.index - b.index)
    .map(({ run }) => run)
  const needle = text.trim().toLowerCase()
  const shown = listed.filter(
    (run) =>
      (!needle || matchesText(run, needle)) &&
      FILTERS.every(([key, , of]) => chosen[key].length === 0 || of(run).some((value) => chosen[key].includes(value)))
  )
  return (
    <>
      <PageTitle>Services</PageTitle>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          className={`${inputClass} min-w-48 flex-1 sm:max-w-xs`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="service, ref, build file, person"
          aria-label="Search"
        />
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {FILTERS.map(([key, name, of, order]) => (
          <FilterPill
            key={key}
            name={name}
            options={countOptions(listed, of, order)}
            chosen={chosen[key]}
            onChange={(next) => setParams(writeChosen(params, key, next), { replace: true })}
          />
        ))}
      </div>
      <Loading query={query}>
        {() => {
          if (shown.length === 0) {
            const narrowed = needle || FILTERS.some(([key]) => chosen[key].length > 0)
            return (
              <Empty>
                {narrowed
                  ? 'No service run is like that.'
                  : 'No service run is starting, up or asleep, or ended in the last day.'}
              </Empty>
            )
          }
          return <ServiceTable runs={shown} now={now} />
        }}
      </Loading>
    </>
  )
}

const HEAD = ['Name', 'Source', 'Started', '']

// the repository of a run's source, as the Tasks page groups by it
const repoOf = (run: ListedRun) => (run.source.type === 'upload' ? 'an upload' : run.source.repo)

// the runs of each repository together, the repositories by name; each keeps its order
function byRepo(runs: ListedRun[]): [string, ListedRun[]][] {
  const groups = new Map<string, ListedRun[]>()
  for (const run of runs) {
    groups.set(repoOf(run), [...(groups.get(repoOf(run)) ?? []), run])
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b))
}

export function ServiceTable({ runs, now }: { runs: ListedRun[]; now: number }) {
  return (
    <Table head={HEAD}>
      {byRepo(runs).map(([repo, list]) => (
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
          {list.map((run) => (
            <ServiceRow key={run.id} run={run} now={now} />
          ))}
        </Fragment>
      ))}
    </Table>
  )
}

// The source below the header of its repository: the branch and commit, or the sandbox
function SourceIn({ run }: { run: ListedRun }) {
  const source = run.source
  if (source.type === 'upload') {
    return <Quiet>an upload</Quiet>
  }
  const links = webLinks(source.repo)
  const commit = (
    <WebLink href={links?.commit?.(source.commit)}>
      <Code>{source.commit.slice(0, 12)}</Code>
    </WebLink>
  )
  if (source.type === 'sandbox') {
    return (
      <span>
        sandbox <Code>{source.id}</Code> at {commit}
        {source.clean === false ? ' with changes' : ''}
      </span>
    )
  }
  return (
    <span>
      <WebLink href={links?.ref?.(source.ref)}>
        <Code>{source.ref}</Code>
      </WebLink>{' '}
      at {commit}
    </span>
  )
}

// When it started, and on hover when it sleeps and ends
function Started({ run, now }: { run: ListedRun; now: number }) {
  const started = run.startedAt ?? run.createdAt
  return (
    <Tip
      tip={
        <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
          <dt className="text-stone-500 dark:text-stone-400">Started</dt>
          <dd>
            <Time iso={started} now={now} />
          </dd>
          <dt className="text-stone-500 dark:text-stone-400">Sleeps</dt>
          <dd>
            <Sleeps run={run} now={now} />
          </dd>
          <dt className="text-stone-500 dark:text-stone-400">Ends</dt>
          <dd>{run.expiresAt ? <Time iso={run.expiresAt} now={now} /> : 'once up'}</dd>
        </dl>
      }
    >
      {relative(started, now)}
    </Tip>
  )
}

// The services of a run by name, each to its first web endpoint while the caller may open it
function ServiceLinks({ run }: { run: ListedRun }) {
  const endpoints = run.up?.endpoints ?? []
  const services = run.up?.services ?? [...new Set(endpoints.map((endpoint) => endpoint.service))]
  return services.map((service, index) => {
    const ports = endpoints.filter((endpoint) => endpoint.service === service)
    const url = ports.find((endpoint) => endpoint.url && /^https?:\/\//.test(endpoint.url))?.url
    const title = ports.map((endpoint) => `${service}:${endpoint.port}`).join(', ') || undefined
    return (
      <Fragment key={service}>
        {index > 0 ? ', ' : null}
        {url ? (
          <a className="link" href={url} rel="noreferrer" title={title}>
            <T>{service}</T>
          </a>
        ) : (
          <span title={title}>
            <T>{service}</T>
          </span>
        )}
      </Fragment>
    )
  })
}

function ServiceRow({ run, now }: { run: ListedRun; now: number }) {
  return (
    <tr>
      <Td>
        <div className="flex items-start gap-2">
          {/* the state, and the run on a click */}
          <RunLink id={run.id}>
            <StateIcon state={run.state} detail={run.wakes ? `woken ${run.wakes}×` : undefined} />
          </RunLink>
          <div>
            <ServiceLinks run={run} />
            <div className="text-xs text-stone-500 dark:text-stone-400">
              {serviceState(run)}
              {run.wakes ? `, woken ${run.wakes}×` : null}
            </div>
          </div>
        </div>
      </Td>
      <Td>
        <SourceIn run={run} />
        <div className="text-xs text-stone-500 dark:text-stone-400">
          <BuildFileLink hash={run.definition} entry={run.entry} />
        </div>
      </Td>
      <Td className="whitespace-nowrap">
        <Started run={run} now={now} />
        {run.owner ? (
          <div className="text-xs text-stone-500 dark:text-stone-400">
            by <Person who={run.owner} />
          </div>
        ) : null}
      </Td>
      <Td>
        <span className="inline-flex items-start gap-2">
          <ExtendButton run={run} />
          <StartButton run={run} />
          <StopButton run={run} />
        </span>
      </Td>
    </tr>
  )
}
