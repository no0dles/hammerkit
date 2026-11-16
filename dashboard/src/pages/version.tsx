import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { hashPath, useApi, type ProposalView } from '../api'
import type { Bundle } from '../../../src/remote/bundle'
import { GraphLegend, PlanTaskPanel, TaskGraph, withServiceNames } from '../graph'
import { CompareVersions } from '../compare'
import { FileBrowser } from '../file-tree'
import { plural } from '../format'
import { PlanTable } from './build-file'
import {
  Card,
  Code,
  Decide,
  Empty,
  Facts,
  Loading,
  PageTabs,
  PageTitle,
  RepoAt,
  Section,
  State,
  T,
  Time,
  useNow,
} from '../ui'

const TABS = ['info', 'graph', 'files'] as const
type Tab = (typeof TABS)[number]

// One proposed build file version, as a published one shows, with what decides about it on top:
// its state, and Publish and Reject for who may. Info (who proposed it, what it changes against
// a published version, and its tasks and services), Graph and Files.
export function VersionPage() {
  const hash = useParams().hash ?? ''
  const navigate = useNavigate()
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
  const proposal = useApi<ProposalView>(`/proposals/${hashPath(hash)}`)
  const waiting = proposal.data?.state === 'waiting'
  // the files are kept while it waits
  const files = useApi<Bundle>(`/proposals/${hashPath(hash)}/files`, { enabled: waiting, refresh: false })
  const plan = useMemo(() => proposal.data && withServiceNames(proposal.data.plan), [proposal.data])
  return (
    <Loading query={proposal} missing={<Empty>There is no such version you may see.</Empty>}>
      {(version) => {
        const counts = [
          plural(version.tasks.length, 'task'),
          ...(version.services.length > 0 ? [plural(version.services.length, 'service')] : []),
        ].join(', ')
        const fileCount = files.data ? Object.keys(files.data.files).length : undefined
        return (
          <>
            <PageTitle note="proposed">{version.entry}</PageTitle>
            <Card className="mb-6 flex flex-col gap-3">
              <div className="flex flex-wrap items-start gap-3 text-sm">
                <State state={version.state} />
                {version.reason ? <T>{version.reason}</T> : null}
              </div>
              {version.canDecide ? (
                // the person may publish it: until when, and the buttons
                <div className="flex flex-col gap-3 rounded-md border border-amber-500/50 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
                  <p>
                    Waits for your approval to be published, until <Time iso={version.expiresAt} now={now} />.
                  </p>
                  <Decide
                    path={`/v1/proposals/${hashPath(version.hash)}`}
                    yes="Publish"
                    onDone={() => navigate('/build-files')}
                  />
                </div>
              ) : waiting ? (
                <Empty>
                  Waits for somebody who may publish, until <Time iso={version.expiresAt} now={now} />.
                </Empty>
              ) : null}
            </Card>
            <PageTabs
              label="What the proposed version shows"
              tabs={[
                { key: 'info', name: 'Info' },
                { key: 'graph', name: 'Graph', note: Object.keys(version.plan).length },
                { key: 'files', name: 'Files', note: fileCount },
              ]}
              current={tab}
              onChange={setTab}
            />
            {tab === 'info' ? (
              <>
                <Card className="mb-6">
                  <Facts items={proposalFacts(version, now)} />
                </Card>
                <Section title="Changes" note="against a published version">
                  <CompareVersions
                    hash={version.hash}
                    plan={version.plan}
                    files={waiting ? files.data?.files : undefined}
                    repo={version.annotations?.repo}
                    path={version.annotations?.path ?? version.entry}
                  />
                </Section>
                <Section title="Tasks and services" note={`${counts}, a click on one opens it`}>
                  {plan ? <PlanTable plan={plan} onSelect={setSelected} /> : null}
                </Section>
              </>
            ) : null}
            {tab === 'graph' && plan ? (
              <>
                <p className="mb-2 text-sm text-stone-500 dark:text-stone-400">{counts}, a click on one opens it.</p>
                <GraphLegend plan={plan} />
                <TaskGraph plan={plan} selected={selected} onSelect={setSelected} />
              </>
            ) : null}
            {tab === 'files' ? (
              waiting ? (
                <Loading query={files}>{(bundle) => <FileBrowser files={bundle.files} />}</Loading>
              ) : (
                <Empty>The files are kept only while the version waits.</Empty>
              )
            ) : null}
            {selected && plan ? <PlanTaskPanel name={selected} plan={plan} onSelect={setSelected} /> : null}
          </>
        )
      }}
    </Loading>
  )
}

// who proposed a version, where from, and the accounts it uses, as a published one shows
function proposalFacts(version: ProposalView, now: number): [ReactNode, ReactNode][] {
  const repo = version.annotations?.repo
  const facts: [ReactNode, ReactNode][] = [
    ['Hash', <Code className="break-all">{version.hash}</Code>],
    [
      'Proposed by',
      <>
        <Code>{version.proposedBy.sub}</Code> <Time iso={version.createdAt} now={now} />
      </>,
    ],
  ]
  if (version.decidedBy) {
    facts.push([
      version.state === 'approved' ? 'Approved by' : 'Decided by',
      <>
        <Code>{version.decidedBy.sub}</Code>
        {version.decidedAt ? (
          <>
            {' '}
            <Time iso={version.decidedAt} now={now} />
          </>
        ) : null}
      </>,
    ])
  }
  if (repo) {
    facts.push(['Repository', <RepoAt repo={repo} commit={version.annotations?.commit} />])
  }
  const others = Object.entries(version.annotations ?? {}).filter(([key]) => key !== 'repo' && key !== 'commit')
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
  if (version.accounts.length > 0) {
    facts.push([
      'Accounts',
      <>
        <T>{version.accounts.join(', ')}</T>
        {version.missing.length > 0 ? (
          <span className="text-stone-500 dark:text-stone-400"> (who publishes uses {version.missing.join(', ')})</span>
        ) : null}
      </>,
    ])
  }
  return facts
}
