import { Fragment, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { hashPath, useApi, type ProposalView } from '../api'
import type { Bundle } from '../../../src/remote/bundle'
import type { DefinitionVersion } from '../../../src/server/definitions'
import { plural, printable } from '../format'
import {
  Card,
  Code,
  Empty,
  StateMark,
  Facts,
  Loading,
  PageTitle,
  Plan,
  Quiet,
  Section,
  T,
  Table,
  Td,
  Time,
  Tip,
  useNow,
  WebLink,
} from '../ui'
import { webLinks } from '../../../src/utils/web-links'

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

// One published version of a build file: who published it, what it runs and its files.
export function BuildFilePage() {
  const hash = useParams().hash ?? ''
  const now = useNow()
  const version = useApi<DefinitionVersion>(`/definitions/${hashPath(hash)}`, { refresh: false })
  const files = useApi<Bundle>(`/definitions/${hashPath(hash)}/files`, { refresh: false })
  return (
    <Loading query={version} missing={<Empty>There is no such build file you may see.</Empty>}>
      {(found) => {
        const facts: [ReactNode, ReactNode][] = [
          ['Hash', <Code>{found.hash}</Code>],
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
        if (found.annotations && Object.keys(found.annotations).length > 0) {
          facts.push([
            'Annotations',
            <span className="flex flex-wrap gap-2">
              {Object.entries(found.annotations).map(([key, value]) => (
                <Code key={key}>{`${key}=${String(value)}`}</Code>
              ))}
            </span>,
          ])
        }
        facts.push(
          ['Tasks', found.tasks.length > 0 ? <T>{found.tasks.join(', ')}</T> : <Quiet>none</Quiet>],
          ['Services', found.services.length > 0 ? <T>{found.services.join(', ')}</T> : <Quiet>none</Quiet>]
        )
        if (found.accounts && found.accounts.length > 0) {
          facts.push(['Accounts', <T>{found.accounts.join(', ')}</T>])
        }
        return (
          <>
            <PageTitle>{found.entry}</PageTitle>
            <Card className="mb-6">
              <Facts items={facts} />
            </Card>
            {found.plan ? (
              <Section title="What it runs">
                <Plan plan={found.plan} />
              </Section>
            ) : null}
            <Loading query={files} missing={<Empty>The server keeps no files of this version.</Empty>}>
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
          </>
        )
      }}
    </Loading>
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
