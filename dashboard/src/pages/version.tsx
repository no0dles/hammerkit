import type { ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { hashPath, useApi, type ProposalView } from '../api'
import type { Bundle } from '../../../src/remote/bundle'
import { printable } from '../format'
import {
  Card,
  Code,
  Decide,
  Empty,
  Facts,
  Loading,
  PageTitle,
  Plan,
  Quiet,
  Section,
  State,
  T,
  Time,
  useNow,
} from '../ui'

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
      <PageTitle>
        {proposal.data ? proposal.data.annotations?.path ?? proposal.data.entry : 'Build file version'}
      </PageTitle>
      <p className="mb-4 text-sm">
        <Link className="link" to="/build-files">
          back to the build files
        </Link>
      </p>
      <Loading query={proposal} missing={<Empty>There is no such version you may see.</Empty>}>
        {(version) => {
          const flagged = Object.entries(version.plan).filter(([, entry]) => entry.flags.length > 0)
          const facts: [ReactNode, ReactNode][] = [
            ['Hash', <Code>{version.hash}</Code>],
            [
              'Proposed by',
              <>
                <Code>{version.proposedBy.sub}</Code> <Time iso={version.createdAt} now={now} />
              </>,
            ],
            ['Tasks', version.tasks.length > 0 ? <T>{version.tasks.join(', ')}</T> : <Quiet>none</Quiet>],
            ['Services', version.services.length > 0 ? <T>{version.services.join(', ')}</T> : <Quiet>none</Quiet>],
          ]
          if (version.accounts.length > 0) {
            facts.push([
              'Accounts',
              <>
                <T>{version.accounts.join(', ')}</T>
                {version.missing.length > 0 ? <Quiet> (who publishes uses {version.missing.join(', ')})</Quiet> : null}
              </>,
            ])
          }
          if (flagged.length > 0) {
            facts.push([
              'Look at',
              <span className="text-amber-700 dark:text-amber-400">
                {printable(flagged.map(([name, entry]) => `${name} (${entry.flags.join(', ')})`).join(', '))}
              </span>,
            ])
          }
          if (version.annotations && Object.keys(version.annotations).length > 0) {
            facts.push([
              'Annotations',
              <span className="flex flex-wrap gap-2">
                {Object.entries(version.annotations).map(([key, value]) => (
                  <Code key={key}>{`${key}=${String(value)}`}</Code>
                ))}
              </span>,
            ])
          }
          return (
            <>
              <Card className="mb-6 flex flex-col gap-5">
                <div className="flex flex-wrap items-start gap-3 text-sm">
                  <State state={version.state} />
                  {version.reason ? <T>{version.reason}</T> : null}
                </div>
                {version.canDecide ? (
                  // the person may publish it: what it waits for, until when, and the buttons
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
                ) : version.state === 'waiting' ? (
                  <Empty>
                    Waits for somebody who may publish, until <Time iso={version.expiresAt} now={now} />.
                  </Empty>
                ) : null}
                <Facts items={facts} />
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
          )
        }}
      </Loading>
    </>
  )
}
