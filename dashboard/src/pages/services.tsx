import { Fragment } from 'react'
import { useApi, type ListedRun } from '../api'
import { webLinks } from '../../../src/utils/web-links'
import { relative } from '../format'
import {
  Code,
  Empty,
  Endpoints,
  Loading,
  Owner,
  PageTitle,
  Quiet,
  ExtendButton,
  StartButton,
  StopButton,
  RunLink,
  Section,
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

export function ServicesPage() {
  const query = useApi<{ runs: ListedRun[] }>('/runs?scope=visible&kind=services')
  const now = useNow()
  return (
    <>
      <PageTitle note="the services of runs that are up, asleep, starting, or ended in the last day">
        Services
      </PageTitle>
      <Loading query={query}>
        {({ runs }) => {
          const starting = runs.filter((run) => ['awaiting-approval', 'queued', 'running'].includes(run.state))
          // each group only while it has runs
          const groups = (
            [
              ['Starting', starting],
              ['Up', runs.filter((run) => run.state === 'up')],
              ['Asleep', runs.filter((run) => run.state === 'asleep')],
              [
                'Past',
                runs.filter(
                  (run) => FINAL.includes(run.state) && now - Date.parse(run.finishedAt ?? run.createdAt) < DAY
                ),
              ],
            ] as [string, ListedRun[]][]
          ).filter(([, list]) => list.length > 0)
          if (groups.length === 0) {
            return <Empty>No service run is starting, up or asleep, or ended in the last day.</Empty>
          }
          return groups.map(([name, list]) => (
            <Section key={name} title={name} note={String(list.length)}>
              <ServiceTable runs={list} now={now} />
            </Section>
          ))
        }}
      </Loading>
    </>
  )
}

const HEAD = ['Name', 'State', 'Endpoints', 'Source', 'Started', '']

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

function ServiceRow({ run, now }: { run: ListedRun; now: number }) {
  return (
    <tr>
      <Td>
        <RunLink id={run.id}>
          <T>{run.up?.name ?? run.id}</T>
        </RunLink>
        <Owner run={run} />
        <div className="text-xs text-stone-500 dark:text-stone-400">
          <T>{(run.up?.services ?? []).join(', ')}</T>
          {run.wakes ? ` · woken ${run.wakes}×` : null}
        </div>
      </Td>
      <Td>
        <StateIcon state={run.state} detail={run.wakes ? `woken ${run.wakes}×` : undefined} />
      </Td>
      <Td>
        <Endpoints run={run} />
      </Td>
      <Td>
        <SourceIn run={run} />
      </Td>
      <Td className="whitespace-nowrap">
        <Started run={run} now={now} />
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
