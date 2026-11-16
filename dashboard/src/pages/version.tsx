import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { hashPath, useApi, type ProposalView } from '../api'
import type { Bundle } from '../../../src/remote/bundle'
import type { DefinitionVersion } from '../../../src/server/definitions'
import { fileOf, GraphLegend, PlanTaskPanel, TaskGraph, withServiceNames } from '../graph'
import { BaseSelect, CompareFiles, planChanges, useCompareBase, type PlanStatus } from '../compare'
import { FilterPill, readChosen, writeChosen } from '../filter-pill'
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
// its state, Publish and Reject for who may, and the published version it is compared with.
// Info (who proposed it, and its tasks and services, the changed ones unless the filter says
// otherwise; a click on one opens where its file declares it), Graph and Files, as a tree with
// what changed.
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
  const compare = useCompareBase(
    hash,
    proposal.data?.annotations?.repo,
    proposal.data?.annotations?.path ?? proposal.data?.entry
  )
  const base = compare.base
  const basePlan = useApi<DefinitionVersion>(`/definitions/${hashPath(base ?? '')}`, {
    enabled: !!base,
    refresh: false,
  })
  const baseFiles = useApi<Bundle>(`/definitions/${hashPath(base ?? '')}/files`, {
    enabled: !!base && waiting,
    refresh: false,
  })
  const changes = useMemo(
    () => (plan && basePlan.data?.plan ? planChanges(withServiceNames(basePlan.data.plan), plan) : undefined),
    [plan, basePlan.data]
  )
  // changed (added, or changed) unless the address says otherwise; `?change=` alone is all
  const chosen = params.has('change') ? readChosen(params, 'change') : ['changed']
  const shownPlan =
    plan && changes && chosen.length > 0
      ? Object.fromEntries(
          Object.entries(plan).filter(([name]) =>
            chosen.includes(changes.status[name] === 'unchanged' ? 'unchanged' : 'changed')
          )
        )
      : plan
  // a click on a task opens where its file declares it, else what it is
  const openTask = (name: string) => {
    const file = plan ? fileOf(name, plan[name]) : undefined
    if (!file || files.data?.files[file] === undefined) {
      setSelected(name)
      return
    }
    const changed = new URLSearchParams(params)
    changed.set('tab', 'files')
    changed.set('file', file)
    changed.set('at', name)
    setParams(changed)
  }
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
              {waiting || compare.choices.length > 0 ? (
                <Loading query={compare.list}>
                  {() => <BaseSelect choices={compare.choices} base={base} onChange={compare.setBase} />}
                </Loading>
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
                <Section title="Tasks and services" note={`${counts}, a click on one opens where it is declared`}>
                  {changes ? (
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <FilterPill
                        name="Compared"
                        options={(['changed', 'unchanged'] as const).map((value) => ({
                          value,
                          count: Object.values(changes.status).filter(
                            (status) => (status === 'unchanged' ? 'unchanged' : 'changed') === value
                          ).length,
                        }))}
                        chosen={chosen}
                        onChange={(next) => {
                          const changed = writeChosen(params, 'change', next)
                          if (next.length === 0) {
                            changed.set('change', '')
                          }
                          setParams(changed, { replace: true })
                        }}
                      />
                    </div>
                  ) : null}
                  {shownPlan && Object.keys(shownPlan).length > 0 ? (
                    <PlanTable
                      plan={shownPlan}
                      marks={changes ? statusMarks(changes.status) : undefined}
                      onSelect={openTask}
                    />
                  ) : (
                    <Empty>Every task and service is the same as in the version it is compared with.</Empty>
                  )}
                  {changes && changes.removed.length > 0 ? (
                    <p className="mt-3 text-sm text-red-700 dark:text-red-400">
                      Removed:{' '}
                      {changes.removed.map((name) => (
                        <Code key={name} className="mr-2">
                          {name}
                        </Code>
                      ))}
                    </p>
                  ) : null}
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
                <Loading query={files}>
                  {(bundle) =>
                    // a version that has nothing to compare with shows its files as they are
                    base ? (
                      <Loading query={baseFiles} missing={<CompareFiles before={undefined} after={bundle.files} />}>
                        {(other) => <CompareFiles before={other.files} after={bundle.files} />}
                      </Loading>
                    ) : (
                      <CompareFiles before={undefined} after={bundle.files} />
                    )
                  }
                </Loading>
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

const MARK_STYLES: Record<PlanStatus, string> = {
  added: 'border-emerald-500 text-emerald-700 dark:text-emerald-400',
  changed: 'border-amber-500 text-amber-700 dark:text-amber-400',
  unchanged: '',
}

function statusMarks(status: Record<string, PlanStatus>): Record<string, ReactNode> {
  return Object.fromEntries(
    Object.entries(status)
      .filter(([, value]) => value !== 'unchanged')
      .map(([name, value]) => [
        name,
        <span className={`rounded-full border px-1.5 text-xs ${MARK_STYLES[value]}`}>{value}</span>,
      ])
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
