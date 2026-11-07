import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { hashPath, useApi, useSession, type ApprovalView, type ListedRun, type ProposalView } from '../api'
import { cut, printable } from '../format'
import {
  Card,
  Code,
  Decide,
  Empty,
  Facts,
  Loading,
  Owner,
  PageTitle,
  Plan,
  Quiet,
  RunLink,
  Section,
  Source,
  State,
  T,
  Table,
  Td,
  Time,
  useNow,
  Work,
} from '../ui'

const DAY = 24 * 60 * 60 * 1000

export function ApprovalsPage() {
  const session = useSession()
  const decide = useApi<{ approvals: ApprovalView[] }>('/approvals')
  const waiting = useApi<{ runs: ListedRun[] }>('/runs?scope=visible&state=awaiting-approval')
  const proposals = useApi<{ proposals: ProposalView[] }>('/proposals')
  const now = useNow()
  const listed = new Map((waiting.data?.runs ?? []).map((run) => [run.id, run]))
  const mine = new Set((decide.data?.approvals ?? []).map((run) => run.id))
  return (
    <>
      <PageTitle>Approvals</PageTitle>
      <Loading query={decide}>
        {({ approvals }) => (
          <Section title="Runs you decide about" note={String(approvals.length)}>
            {approvals.length === 0 ? (
              <Empty>No run waits for an account you use.</Empty>
            ) : (
              <div className="flex flex-col gap-3">
                {approvals.map((run) => (
                  <RunCard key={run.id} run={run} listed={listed.get(run.id)} now={now} decide />
                ))}
              </div>
            )}
          </Section>
        )}
      </Loading>
      <Loading query={waiting}>
        {({ runs }) => {
          const own = runs.filter((run) => !run.owner)
          const others = runs.filter((run) => run.owner && !mine.has(run.id))
          return (
            <>
              {own.length > 0 ? (
                <Section title="Your runs that wait">
                  <div className="flex flex-col gap-3">
                    {own.map((run) => (
                      <RunCard key={run.id} run={run} listed={run} now={now} />
                    ))}
                  </div>
                </Section>
              ) : null}
              {others.length > 0 ? (
                <Section title="Runs of others that wait">
                  <div className="flex flex-col gap-3">
                    {others.map((run) => (
                      <RunCard key={run.id} run={run} listed={run} now={now} />
                    ))}
                  </div>
                </Section>
              ) : null}
            </>
          )
        }}
      </Loading>
      <Loading query={proposals}>
        {(data) => {
          const open = data.proposals.filter((proposal) => proposal.state === 'waiting')
          const decided = data.proposals
            .filter((proposal) => proposal.state !== 'waiting' && now - Date.parse(proposal.decidedAt ?? '') < DAY)
            .slice(0, 20)
          return (
            <>
              <Section title="Build file versions to publish" note={String(open.length)}>
                {open.length === 0 ? (
                  <Empty>
                    {session.data?.publishes
                      ? 'No version waits to be published.'
                      : 'You may not publish build files, and proposed none that waits.'}
                  </Empty>
                ) : (
                  <div className="flex flex-col gap-3">
                    {open.map((proposal) => (
                      <VersionCard key={proposal.hash} proposal={proposal} now={now} />
                    ))}
                  </div>
                )}
              </Section>
              {decided.length > 0 ? (
                <Section title="Decided in the last day">
                  <Table head={['Version', 'State', 'Proposed by', 'Decided']}>
                    {decided.map((proposal) => (
                      <tr key={proposal.hash}>
                        <Td>
                          <Link className="link" to={`/approvals/versions/${encodeURIComponent(proposal.hash)}`}>
                            <Code>{`${proposal.hash.slice(0, 19)}…`}</Code>
                          </Link>
                        </Td>
                        <Td>
                          <State state={proposal.state} />
                          {proposal.reason ? (
                            <div className="text-xs">{printable(cut(proposal.reason, 200))}</div>
                          ) : null}
                        </Td>
                        <Td>
                          <T>{proposal.proposedBy.sub}</T>
                        </Td>
                        <Td className="whitespace-nowrap">
                          {proposal.decidedBy ? (
                            <>
                              <T>{proposal.decidedBy.sub}</T>{' '}
                            </>
                          ) : null}
                          <Time iso={proposal.decidedAt} now={now} />
                        </Td>
                      </tr>
                    ))}
                  </Table>
                </Section>
              ) : null}
            </>
          )
        }}
      </Loading>
    </>
  )
}

function RunCard({
  run,
  listed,
  now,
  decide = false,
}: {
  run: ApprovalView | ListedRun
  listed: ListedRun | undefined
  now: number
  decide?: boolean
}) {
  const approvals = run.approvals ?? []
  const done = approvals.filter((approval) => approval.approvedBy)
  const by = 'requestedBy' in run ? run.requestedBy : run.owner
  return (
    <Card className="flex flex-col gap-3">
      <Facts
        items={[
          [
            'Run',
            <>
              <RunLink id={run.id} />
              <Owner run={{ owner: by }} />
            </>,
          ],
          ['What', <Work run={listed ?? { tasks: run.tasks }} />],
          ['Source', <Source run={run} />],
          [
            'Needs',
            <>
              {approvals
                .filter((approval) => !approval.approvedBy)
                .map((approval) => approval.account)
                .join(', ')}
              {done.length > 0 ? (
                <Quiet>
                  {' '}
                  ({done.map((approval) => `${approval.account} approved by ${approval.approvedBy?.sub}`).join(', ')})
                </Quiet>
              ) : null}
            </>,
          ],
          ['Decide before', <Time iso={approvals[0]?.expiresAt} now={now} />],
        ]}
      />
      {decide && 'plan' in run && run.plan ? (
        <details>
          <summary className="cursor-pointer text-sm text-emerald-700 dark:text-emerald-400">What it runs</summary>
          <div className="mt-2">
            <Plan plan={run.plan} args={(run.options as { args?: unknown } | undefined)?.args} />
          </div>
        </details>
      ) : null}
      {decide ? <Decide path={`/v1/approvals/${encodeURIComponent(run.id)}`} yes="Approve" /> : null}
    </Card>
  )
}

function VersionCard({ proposal, now }: { proposal: ProposalView; now: number }) {
  const session = useSession()
  const flagged = Object.entries(proposal.plan).filter(([, entry]) => entry.flags.length > 0)
  const path = `/approvals/versions/${encodeURIComponent(proposal.hash)}`
  return (
    <Card className="flex flex-col gap-3">
      <Facts
        items={[
          [
            'Version',
            <Link className="link" to={path}>
              <Code>{`${proposal.hash.slice(0, 19)}…`}</Code>
            </Link>,
          ],
          [
            'Proposed by',
            <>
              <Code>{proposal.proposedBy.sub}</Code> <Time iso={proposal.createdAt} now={now} />
            </>,
          ],
          [
            'Tasks',
            <>
              {proposal.tasks.length > 0 ? <T>{proposal.tasks.join(', ')}</T> : <Quiet>none</Quiet>}
              {proposal.services.length > 0 ? (
                <div className="text-xs">
                  services <T>{proposal.services.join(', ')}</T>
                </div>
              ) : null}
            </>,
          ],
          ...(proposal.accounts.length > 0
            ? ([
                [
                  'Accounts',
                  <>
                    {proposal.accounts.join(', ')}
                    {proposal.missing.length > 0 ? (
                      <Quiet> (who approves uses {proposal.missing.join(', ')})</Quiet>
                    ) : null}
                  </>,
                ],
              ] as [string, ReactNode][])
            : []),
          ...(flagged.length > 0
            ? ([
                [
                  'Look at',
                  <span className="text-amber-700 dark:text-amber-400">
                    {printable(flagged.map(([name, entry]) => `${name} (${entry.flags.join(', ')})`).join(', '))}
                  </span>,
                ],
              ] as [string, ReactNode][])
            : []),
          ['Decide before', <Time iso={proposal.expiresAt} now={now} />],
        ]}
      />
      {proposal.canDecide ? (
        <Decide path={`/v1/proposals/${hashPath(proposal.hash)}`} yes="Publish" />
      ) : proposal.mine && !session.data?.publishes ? (
        <Empty>Waits for somebody who may publish.</Empty>
      ) : null}
    </Card>
  )
}
