import { Fragment, useState, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { hashPath, useApi, type ProposalView, type TaskPlan, type TaskStats } from '../api'
import type { Bundle } from '../../../src/remote/bundle'
import type { DefinitionVersion } from '../../../src/server/definitions'
import { plural, printable, span } from '../format'
import {
  Card,
  Code,
  Empty,
  StateMark,
  Facts,
  Loading,
  PageTabs,
  PageTitle,
  Quiet,
  RepoAt,
  Section,
  T,
  Table,
  Td,
  Time,
  Tip,
  useNow,
  useSort,
  WebLink,
} from '../ui'
import { webLinks } from '../../../src/utils/web-links'
import {
  BuildFiles,
  cacheRate,
  fileOf,
  GraphLegend,
  percent,
  PlanTaskPanel,
  statsNote,
  successRate,
  TaskGraph,
  withServiceNames,
} from '../graph'

// Where a build file version is shown: its page, by its hash.
export function buildFilePath(hash: string): string {
  return `/build-files/${hashPath(hash)}`
}

// A build file version as the server keeps it, linked to its page: where it is in the
// repository, and the start of its hash.
export function BuildFileLink({ hash, entry }: { hash: string; entry?: string }) {
  return (
    <Link className="link font-mono text-[0.85em]" to={buildFilePath(hash)} title={hash}>
      {entry ? printable(entry) : `${hash.slice(0, 19)}…`}
    </Link>
  )
}

// what the numbers of a build file's tasks are over: the runs of its repository in this time
const PERIOD = '7d'
const PERIOD_NAME = 'last 7 days'

const TABS = ['info', 'graph', 'files'] as const
type Tab = (typeof TABS)[number]

// One published version of a build file, in three tabs: Info (who published it, and its tasks and
// services in a table with what their past runs say), Graph (them as a graph) and Files (the
// files as they are). A click on a task in the table or the graph opens it in a panel.
export function BuildFilePage() {
  const hash = useParams().hash ?? ''
  const now = useNow()
  const [params, setParams] = useSearchParams()
  const asked = params.get('tab') as Tab
  const tab: Tab = TABS.includes(asked) ? asked : 'info'
  const setTab = (next: Tab) => {
    const changed = new URLSearchParams(params)
    if (next === 'info') {
      changed.delete('tab')
    } else {
      changed.set('tab', next)
    }
    setParams(changed, { replace: true })
  }
  const [selected, setSelected] = useState<string | null>(null)
  const version = useApi<DefinitionVersion>(`/definitions/${hashPath(hash)}`, { refresh: false })
  const files = useApi<Bundle>(`/definitions/${hashPath(hash)}/files`, { refresh: false })
  // the past runs of its tasks, of the runs of its repository the person may see
  const repo = version.data?.annotations?.repo
  const tasks = useApi<{ tasks: TaskStats[] }>(`/tasks?since=${PERIOD}`, { enabled: !!repo })
  return (
    <Loading query={version} missing={<Empty>There is no such build file you may see.</Empty>}>
      {(found) => {
        const plan = found.plan && withServiceNames(found.plan)
        const stats: Record<string, TaskStats> = Object.fromEntries(
          (tasks.data?.tasks ?? [])
            .filter((entry) => entry.repo === repo && plan?.[entry.task])
            .map((entry) => [entry.task, entry])
        )
        const counts = [
          plural(found.tasks.length, 'task'),
          ...(found.services.length > 0 ? [plural(found.services.length, 'service')] : []),
        ].join(', ')
        const noPlan = <Empty>This version was published before the server kept what it runs.</Empty>
        const fileCount = files.data ? Object.keys(files.data.files).length : undefined
        return (
          <>
            <PageTitle>{found.entry}</PageTitle>
            <PageTabs
              label="What the build file shows"
              tabs={[
                { key: 'info', name: 'Info' },
                { key: 'graph', name: 'Graph', note: plan ? Object.keys(plan).length : undefined },
                { key: 'files', name: 'Files', note: fileCount },
              ]}
              current={tab}
              onChange={setTab}
            />
            {tab === 'info' ? (
              <>
                <Card className="mb-6">
                  <Facts items={versionFacts(found, now)} />
                </Card>
                {repo && plan ? <RunNumbers stats={Object.values(stats)} loading={tasks.isLoading} /> : null}
                <Section title="Tasks and services" note={`${counts}, a click on one opens it`}>
                  {plan ? <PlanTable plan={plan} stats={repo ? stats : undefined} onSelect={setSelected} /> : noPlan}
                </Section>
              </>
            ) : null}
            {tab === 'graph' ? (
              plan ? (
                <>
                  <p className="mb-2 text-sm text-stone-500 dark:text-stone-400">
                    {counts}, a click on one opens it
                    {repo ? `; each box says how often it came from the cache in the ${PERIOD_NAME}` : ''}.
                  </p>
                  <GraphLegend />
                  <TaskGraph
                    plan={plan}
                    notes={Object.fromEntries(Object.entries(stats).map(([name, entry]) => [name, statsNote(entry)]))}
                    selected={selected}
                    onSelect={setSelected}
                  />
                </>
              ) : (
                noPlan
              )
            ) : null}
            {tab === 'files' ? (
              <Loading query={files} missing={<Empty>The server keeps no files of this version.</Empty>}>
                {(bundle) => <BuildFiles files={bundle.files} open />}
              </Loading>
            ) : null}
            {selected && plan ? (
              <PlanTaskPanel
                name={selected}
                plan={plan}
                inputs={found.inputs}
                stats={repo ? { of: stats, period: PERIOD_NAME } : undefined}
                onSelect={setSelected}
              />
            ) : null}
          </>
        )
      }}
    </Loading>
  )
}

// who published a version, where from, and what it is allowed
function versionFacts(found: DefinitionVersion, now: number): [ReactNode, ReactNode][] {
  const repo = found.annotations?.repo
  const commit = found.annotations?.commit
  const facts: [ReactNode, ReactNode][] = [
    ['Hash', <Code className="break-all">{found.hash}</Code>],
    [
      'Published by',
      <>
        <Code>{found.publishedBy.sub}</Code> <Time iso={found.publishedAt} now={now} />
      </>,
    ],
  ]
  if (found.approvedBy) {
    facts.push(['Approved by', <Code>{found.approvedBy.sub}</Code>])
  }
  if (found.yanked) {
    facts.push([
      'Yanked',
      <>
        by <Code>{found.yanked.by.sub}</Code> <Time iso={found.yanked.at} now={now} />
        {found.yanked.reason ? (
          <>
            : <T>{found.yanked.reason}</T>
          </>
        ) : null}
      </>,
    ])
  }
  if (repo) {
    facts.push(['Repository', <RepoAt repo={repo} commit={commit} />])
  }
  const others = Object.entries(found.annotations ?? {}).filter(([key]) => key !== 'repo' && key !== 'commit')
  if (others.length > 0) {
    facts.push([
      'Annotations',
      <span className="flex flex-wrap gap-2">
        {others.map(([key, value]) => (
          <Code key={key}>{`${key}=${String(value)}`}</Code>
        ))}
      </span>,
    ])
  }
  if (found.accounts && found.accounts.length > 0) {
    facts.push(['Accounts', <T>{found.accounts.join(', ')}</T>])
  }
  return facts
}

// The past runs of a build file's tasks added up: how many, how many came from the cache and
// passed, and the time they ran
function RunNumbers({ stats, loading }: { stats: TaskStats[]; loading: boolean }) {
  const runs = stats.reduce((sum, entry) => sum + entry.runs, 0)
  const cached = stats.reduce((sum, entry) => sum + entry.cached, 0)
  const failed = stats.reduce((sum, entry) => sum + entry.failed, 0)
  const ran = stats.reduce((sum, entry) => sum + (entry.totalMs ?? 0), 0)
  const tiles: [string, string, string][] = [
    ['Task runs', String(runs), `of its tasks in the ${PERIOD_NAME}`],
    ['From the cache', runs ? percent(cached / runs) : '–', `${cached} of ${runs}`],
    ['Passed', runs ? percent((runs - failed) / runs) : '–', failed ? `${failed} failed` : 'none failed'],
    ['Time run', ran ? span(ran) : '–', 'what ran, not the cache'],
  ]
  return (
    <section aria-label={`The ${PERIOD_NAME}`} className="mb-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map(([name, value, note]) => (
          <Card key={name} className="p-3!">
            <div className="text-xs text-stone-500 dark:text-stone-400">{name}</div>
            <div className="text-xl font-semibold tabular-nums">{loading ? '…' : value}</div>
            <div className="text-xs text-stone-500 dark:text-stone-400">{loading ? '' : note}</div>
          </Card>
        ))}
      </div>
    </section>
  )
}

interface PlanRow {
  name: string
  entry: TaskPlan
  file: string
  stats?: TaskStats
}

const PLAN_SORT = {
  name: (row: PlanRow) => row.name,
  file: (row: PlanRow) => row.file,
  deps: (row: PlanRow) => row.entry.deps.length + row.entry.needs.length,
  runs: (row: PlanRow) => row.stats?.runs,
  cache: (row: PlanRow) => (row.stats ? cacheRate(row.stats) : undefined),
  success: (row: PlanRow) => (row.stats ? successRate(row.stats) : undefined),
  median: (row: PlanRow) => row.stats?.medianMs,
}
const PLAN_KEYS: (keyof typeof PLAN_SORT)[] = ['name', 'file', 'deps', 'runs', 'cache', 'success', 'median']

// The tasks and services of a build file in a table, with what their past runs say when there
// are any; a click on one opens it
function PlanTable({
  plan,
  stats,
  onSelect,
}: {
  plan: Record<string, TaskPlan>
  // left out when the version names no repository to count the runs of
  stats?: Record<string, TaskStats>
  onSelect: (name: string) => void
}) {
  const sorted = useSort(
    Object.entries(plan).map(([name, entry]) => ({
      name,
      entry,
      file: fileOf(name, entry),
      ...(stats?.[name] ? { stats: stats[name] } : {}),
    })),
    PLAN_SORT,
    { key: 'name', dir: 'asc' }
  )
  const head = ['Name', 'Build file', 'Waits for', ...(stats ? ['Runs', 'Cached', 'Passed', 'Median'] : [])]
  return (
    <Table
      head={head}
      right={head.map((_, index) => index >= 3)}
      sort={{ keys: PLAN_KEYS.slice(0, head.length), state: sorted.state, onSort: sorted.onSort }}
    >
      {sorted.rows.map(({ name, entry, file, stats: row }) => (
        <tr key={name} className="hover:bg-stone-50 dark:hover:bg-stone-800/40">
          <Td>
            <button
              type="button"
              onClick={() => onSelect(name)}
              className="cursor-pointer text-left font-mono text-[0.85em] font-medium hover:underline"
            >
              {printable(name)}
            </button>
            <div className="text-xs text-stone-500 dark:text-stone-400">
              {entry.kind === 'service' ? (
                <span className="mr-1 rounded-full border border-violet-400 px-1.5 text-violet-700 dark:border-violet-500 dark:text-violet-300">
                  service
                </span>
              ) : null}
              {entry.runtime === 'none'
                ? entry.kind === 'service'
                  ? ''
                  : 'groups its dependencies'
                : entry.image
                  ? printable(entry.image)
                  : entry.runtime}
              {entry.flags.length > 0 ? (
                <span className="ml-1 text-amber-700 dark:text-amber-400">· to look at: {entry.flags.join(', ')}</span>
              ) : null}
            </div>
          </Td>
          <Td className="whitespace-nowrap">
            <Code>{file}</Code>
          </Td>
          <Td>
            {entry.deps.length + entry.needs.length > 0 ? (
              <span className="text-xs">{printable([...entry.deps, ...entry.needs].join(', '))}</span>
            ) : (
              <Quiet>nothing</Quiet>
            )}
          </Td>
          {stats ? (
            <>
              <Td num>{row ? row.runs : <Quiet>–</Quiet>}</Td>
              <Td num>
                {row ? (
                  <span title={`${row.cached} of ${row.runs} from the cache`}>{percent(cacheRate(row))}</span>
                ) : null}
              </Td>
              <Td
                num
                className={
                  row && row.failed > 0
                    ? (successRate(row) ?? 1) < 0.5
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-amber-600 dark:text-amber-400'
                    : ''
                }
              >
                {row ? <span title={`${row.failed} of ${row.runs} failed`}>{percent(successRate(row))}</span> : null}
              </Td>
              <Td num>{row ? span(row.medianMs) : null}</Td>
            </>
          ) : null}
        </tr>
      ))}
    </Table>
  )
}

// What the list of build files tells of each version.
type VersionSummary = Pick<
  DefinitionVersion,
  'hash' | 'entry' | 'publishedAt' | 'publishedBy' | 'approvedBy' | 'tasks' | 'services' | 'yanked'
> & { annotations: Record<string, string>; accounts: string[] }

// where a proposed version shows whole, with Publish and Reject for who may
export function proposedPath(hash: string): string {
  return `/build-files/proposed/${hashPath(hash)}`
}

const DAY = 24 * 60 * 60 * 1000
const NO_REPO = 'no repository given'

// A version in the list: published, or proposed and waiting, or decided against.
interface Row {
  hash: string
  path: string
  href: string
  state: string
  annotations: Record<string, string>
  tasks: string[]
  services: string[]
  by: string
  // who let it in, or decided against it
  decidedBy?: string
  at: string
  // the person may publish it
  canDecide?: boolean
}

function rows(published: VersionSummary[], proposals: ProposalView[], now: number): Row[] {
  const known = new Set(published.map((version) => version.hash))
  return [
    ...published.map((version) => ({
      hash: version.hash,
      path: version.annotations.path ?? version.entry,
      href: buildFilePath(version.hash),
      state: version.yanked ? 'yanked' : 'published',
      annotations: version.annotations,
      tasks: version.tasks,
      services: version.services,
      by: version.publishedBy.sub,
      ...(version.approvedBy ? { decidedBy: `approved by ${version.approvedBy.sub}` } : {}),
      at: version.publishedAt,
    })),
    // those that wait, and those decided against in the last day; one that was published is above
    ...proposals
      .filter(
        (proposal) =>
          !known.has(proposal.hash) &&
          (proposal.state === 'waiting' || now - Date.parse(proposal.decidedAt ?? '') < DAY)
      )
      .map((proposal) => ({
        hash: proposal.hash,
        path: proposal.annotations?.path ?? proposal.entry,
        href: proposedPath(proposal.hash),
        state: proposal.state,
        annotations: proposal.annotations ?? {},
        tasks: proposal.tasks,
        services: proposal.services,
        by: `proposed by ${proposal.proposedBy.sub}`,
        ...(proposal.decidedBy ? { decidedBy: `${proposal.state} by ${proposal.decidedBy.sub}` } : {}),
        at: proposal.createdAt,
        canDecide: proposal.canDecide,
      })),
  ]
}

// The versions of each repository together, those that wait first and then the newest, the
// repositories by name; the repository is the one the publisher's checkout named (`repo`).
function byRepo(list: Row[]): [string, Row[]][] {
  const groups = new Map<string, Row[]>()
  const sorted = [...list].sort(
    (a, b) => Number(b.state === 'waiting') - Number(a.state === 'waiting') || Date.parse(b.at) - Date.parse(a.at)
  )
  for (const row of sorted) {
    const repo = row.annotations.repo ?? NO_REPO
    groups.set(repo, [...(groups.get(repo) ?? []), row])
  }
  return [...groups].sort(([a], [b]) => (a === NO_REPO ? 1 : b === NO_REPO ? -1 : a.localeCompare(b)))
}

// The build files by repository: the published versions and those proposed, each with its
// state. Publishing and rejecting are on the page of a proposed version.
export function BuildFilesPage() {
  const list = useApi<{ definitions: VersionSummary[] }>('/definitions')
  const proposals = useApi<{ proposals: ProposalView[] }>('/proposals')
  const now = useNow()
  return (
    <>
      <PageTitle>Build files</PageTitle>
      <Loading query={list} missing={<Empty>You may not see the build files of this server.</Empty>}>
        {({ definitions }) => {
          const all = rows(definitions, proposals.data?.proposals ?? [], now)
          if (all.length === 0) {
            return <Empty>No build file is published or proposed.</Empty>
          }
          return (
            <Table head={['Build file', 'Commit', 'Tasks', 'Published']} right={HEAD_RIGHT}>
              {byRepo(all).map(([repo, group]) => (
                <Fragment key={repo}>
                  <tr className="bg-stone-50 dark:bg-stone-950/40">
                    <th
                      colSpan={4}
                      scope="colgroup"
                      className="px-3 py-1.5 text-left text-xs font-medium text-stone-600 dark:text-stone-300"
                    >
                      <WebLink href={webLinks(repo)?.repo}>
                        <T>{repo}</T>
                      </WebLink>
                    </th>
                  </tr>
                  {group.map((row) => (
                    <tr key={row.hash}>
                      <Td className="whitespace-nowrap">
                        <div className="flex items-start gap-2">
                          <StateMark state={row.state} />
                          <div>
                            <Link className="link font-mono text-[0.85em]" to={row.href} title={row.hash}>
                              {printable(row.path)}
                            </Link>
                            <div className="text-xs text-stone-500 dark:text-stone-400">
                              <span className="font-mono" title={row.hash}>
                                {row.hash.slice(7, 19)}
                              </span>{' '}
                              {row.canDecide ? (
                                // waits for the person: the pause mark says it waits, this says for whom
                                <Link
                                  to={row.href}
                                  className="rounded-full bg-amber-500 px-1.5 font-medium whitespace-nowrap text-white hover:bg-amber-600"
                                >
                                  your approval
                                </Link>
                              ) : (
                                row.state
                              )}
                            </div>
                          </div>
                        </div>
                      </Td>
                      <Td className="whitespace-nowrap">
                        {row.annotations.commit ? (
                          <WebLink
                            href={
                              row.annotations.repo
                                ? webLinks(row.annotations.repo)?.commit?.(row.annotations.commit)
                                : undefined
                            }
                          >
                            <Code>{row.annotations.commit.slice(0, 12)}</Code>
                          </WebLink>
                        ) : (
                          <Quiet>not known</Quiet>
                        )}
                        {row.annotations.dirty ? <div className="text-xs text-amber-600">with changes</div> : null}
                      </Td>
                      <Td className="whitespace-nowrap">
                        <Tip
                          tip={
                            <dl className="grid max-w-80 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 whitespace-normal">
                              <dt className="text-stone-500 dark:text-stone-400">Tasks</dt>
                              <dd>{printable(row.tasks.join(', ')) || 'none'}</dd>
                              <dt className="text-stone-500 dark:text-stone-400">Services</dt>
                              <dd>{printable(row.services.join(', ')) || 'none'}</dd>
                            </dl>
                          }
                        >
                          {plural(row.tasks.length, 'task')}
                          {row.services.length > 0 ? `, ${plural(row.services.length, 'service')}` : ''}
                        </Tip>
                      </Td>
                      <Td num>
                        <Time iso={row.at} now={now} />
                        <div className="text-xs text-stone-500 dark:text-stone-400">
                          <T>{row.by}</T>
                        </div>
                        {row.decidedBy ? (
                          <div className="text-xs text-stone-500 dark:text-stone-400">
                            <T>{row.decidedBy}</T>
                          </div>
                        ) : null}
                      </Td>
                    </tr>
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

const HEAD_RIGHT = [false, false, false, true]
