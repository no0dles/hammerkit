import { Link, useNavigate, useParams } from 'react-router'
import { hashPath, useApi, type ProposalView } from '../api'
import type { Bundle } from '../../../src/remote/bundle'
import { printable } from '../format'
import { Card, Code, Decide, Empty, Facts, Loading, PageTitle, Plan, Section, State, T, Time, useNow } from '../ui'

// One proposed build file version whole: its plan and its files, as who decides reads them.
export function VersionPage() {
  const hash = useParams().hash ?? ''
  const navigate = useNavigate()
  const now = useNow()
  const proposal = useApi<ProposalView>(`/proposals/${hashPath(hash)}`)
  const waiting = proposal.data?.state === 'waiting'
  const files = useApi<Bundle>(`/proposals/${hashPath(hash)}/files`, { enabled: waiting, refresh: false })
  return (
    <>
      <PageTitle>Build file version</PageTitle>
      <p className="mb-4 text-sm">
        <Link className="link" to="/approvals">
          back to the approvals
        </Link>
      </p>
      <Loading query={proposal} missing={<Empty>There is no such version you may see.</Empty>}>
        {(version) => (
          <>
            <Card className="mb-6 flex flex-col gap-4">
              <Facts
                items={[
                  ['Hash', <Code>{version.hash}</Code>],
                  [
                    'State',
                    <>
                      <State state={version.state} /> {version.reason ? <T>{version.reason}</T> : null}
                    </>,
                  ],
                  [
                    'Proposed by',
                    <>
                      <Code>{version.proposedBy.sub}</Code> <Time iso={version.createdAt} now={now} />
                    </>,
                  ],
                  ['Entry', <Code>{version.entry}</Code>],
                  ...(version.annotations && Object.keys(version.annotations).length > 0
                    ? ([
                        [
                          'Annotations',
                          <span className="flex flex-wrap gap-2">
                            {Object.entries(version.annotations).map(([key, value]) => (
                              <Code key={key}>{`${key}=${String(value)}`}</Code>
                            ))}
                          </span>,
                        ],
                      ] as [string, React.ReactNode][])
                    : []),
                ]}
              />
              {version.canDecide ? (
                <Decide
                  path={`/v1/proposals/${hashPath(version.hash)}`}
                  yes="Publish"
                  onDone={() => navigate('/approvals')}
                />
              ) : null}
            </Card>
            <Section title="What it runs">
              <Plan plan={version.plan} />
            </Section>
            {waiting ? (
              <Loading query={files}>
                {(bundle) => (
                  <Section title="Files" note={String(Object.keys(bundle.files).length)}>
                    <div className="flex flex-col gap-4">
                      {Object.entries(bundle.files).map(([name, text]) => (
                        <div key={name}>
                          <h3 className="mb-1 text-sm font-medium">
                            <Code>{name}</Code>
                          </h3>
                          <pre className="log whitespace-pre-wrap">{printable(text)}</pre>
                        </div>
                      ))}
                    </div>
                  </Section>
                )}
              </Loading>
            ) : (
              <Empty>The files are kept only while the version waits.</Empty>
            )}
          </>
        )}
      </Loading>
    </>
  )
}
