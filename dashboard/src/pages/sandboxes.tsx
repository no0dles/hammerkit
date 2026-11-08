import { Fragment, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { remove, useAction, useApi, useApiText } from '../api'
import type { Sandbox } from '../../../src/server/sandboxes'
import type { ChangedFile } from '../../../src/server/sandbox-files'
import { formatMemory, plural, printable } from '../format'
import {
  Bar,
  Card,
  Code,
  Empty,
  ErrorNote,
  Facts,
  Loading,
  PageTitle,
  Quiet,
  RunLink,
  Section,
  T,
  Table,
  Td,
  Time,
  useNow,
} from '../ui'

// A sandbox as the API shows it to its owner: and the run that works on it now, if one does.
type SandboxView = Omit<Sandbox, 'owner'> & { busy: boolean; run: string | null }

interface SandboxList {
  sandboxes: SandboxView[]
  limits: { count: number; bytes: number }
  used: { count: number; bytes: number }
}

export function sandboxPath(id: string): string {
  return `/sandboxes/${encodeURIComponent(id)}`
}

// the sandboxes of each repository together, the repositories by name, the last used first in each
function byRepo(sandboxes: SandboxView[]): [string, SandboxView[]][] {
  const groups = new Map<string, SandboxView[]>()
  for (const sandbox of [...sandboxes].sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt))) {
    groups.set(sandbox.repo, [...(groups.get(sandbox.repo) ?? []), sandbox])
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b))
}

// What a sandbox shows of its branch: where it was fetched from, the commit, what it pushed.
function Branch({ sandbox }: { sandbox: SandboxView }) {
  const pushed = Object.entries(sandbox.pushed ?? {})
  return (
    <>
      <Code className="break-normal">{sandbox.ref}</Code>
      <div className="text-xs text-stone-500 dark:text-stone-400">
        at <Code className="break-normal">{sandbox.commit.slice(0, 12)}</Code>
      </div>
      {pushed.length > 0 ? (
        <div className="text-xs text-stone-500 dark:text-stone-400">
          pushed{' '}
          {pushed.map(([branch, commit], index) => (
            <Fragment key={branch}>
              {index > 0 ? ', ' : ''}
              <Code>{branch}</Code> <Quiet>at</Quiet> <Code>{commit.slice(0, 12)}</Code>
            </Fragment>
          ))}
        </div>
      ) : null}
    </>
  )
}

// Removes a sandbox, once asked: a run on it stops, and what was not pushed is gone.
function DeleteButton({ sandbox, onDone }: { sandbox: SandboxView; onDone?: () => void }) {
  const removal = useAction(() => remove(`/v1/sandboxes/${encodeURIComponent(sandbox.id)}`))
  const ask = sandbox.run
    ? `Delete ${sandbox.id}? The run ${sandbox.run} that works on it stops, and what was not pushed is gone.`
    : `Delete ${sandbox.id}? What was not pushed is gone.`
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        title="Delete"
        aria-label={`Delete ${sandbox.id}`}
        disabled={removal.isPending}
        onClick={() => {
          if (window.confirm(ask)) {
            removal.mutate(undefined, { onSuccess: () => onDone?.() })
          }
        }}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
      >
        <svg
          viewBox="0 0 16 16"
          aria-hidden="true"
          className="h-4 w-4 fill-none stroke-current"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.75 8.5h6.5L12 4.5M6.75 7v4M9.25 7v4" />
        </svg>
      </button>
      {removal.error ? <ErrorNote error={removal.error} /> : null}
    </span>
  )
}

// The checkouts of the person on the server that runs work on: theirs alone, nobody else sees them.
export function SandboxesPage() {
  const list = useApi<SandboxList>('/sandboxes')
  const now = useNow()
  return (
    <>
      <PageTitle>Sandboxes</PageTitle>
      <Loading query={list} missing={<Empty>This server keeps no sandboxes.</Empty>}>
        {({ sandboxes, limits, used }) => (
          <>
            <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Card className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between gap-2">
                  <strong className="text-sm">Sandboxes</strong>
                  <Quiet>
                    <span className="text-sm">
                      {used.count} of {limits.count}
                    </span>
                  </Quiet>
                </div>
                <Bar value={used.count} max={limits.count} />
              </Card>
              <Card className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between gap-2">
                  <strong className="text-sm">Space</strong>
                  <Quiet>
                    <span className="text-sm">
                      {formatMemory(used.bytes)} of {formatMemory(limits.bytes)}
                    </span>
                  </Quiet>
                </div>
                <Bar value={used.bytes} max={limits.bytes} />
              </Card>
            </div>
            {sandboxes.length === 0 ? (
              <Empty>You have no sandbox on this server.</Empty>
            ) : (
              <Table
                head={['Sandbox', 'Branch', 'Size', 'Last used', 'Created', '']}
                right={[false, false, true, true, true, true]}
              >
                {byRepo(sandboxes).map(([repo, group]) => (
                  <Fragment key={repo}>
                    <tr className="bg-stone-50 dark:bg-stone-950/40">
                      <th
                        colSpan={6}
                        scope="colgroup"
                        className="px-3 py-1.5 text-left text-xs font-medium text-stone-600 dark:text-stone-300"
                      >
                        <T>{repo}</T>
                      </th>
                    </tr>
                    {group.map((sandbox) => (
                      <tr key={sandbox.id}>
                        <Td className="whitespace-nowrap">
                          <Link className="link font-mono text-[0.85em]" to={sandboxPath(sandbox.id)}>
                            {sandbox.id}
                          </Link>
                          <div className="text-xs text-stone-500 dark:text-stone-400">
                            {sandbox.run ? (
                              <>
                                busy with <RunLink id={sandbox.run} />
                              </>
                            ) : (
                              'free'
                            )}
                          </div>
                        </Td>
                        <Td className="whitespace-nowrap">
                          <Branch sandbox={sandbox} />
                        </Td>
                        <Td num>{formatMemory(sandbox.bytes)}</Td>
                        <Td num>
                          <Time iso={sandbox.lastUsedAt} now={now} />
                        </Td>
                        <Td num>
                          <Time iso={sandbox.createdAt} now={now} />
                        </Td>
                        <Td className="text-right">
                          <DeleteButton sandbox={sandbox} />
                        </Td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </Table>
            )}
          </>
        )}
      </Loading>
    </>
  )
}

const CHANGE_STYLES: Record<string, string> = {
  added: 'text-emerald-700 dark:text-emerald-400',
  deleted: 'text-red-700 dark:text-red-400',
}

// One sandbox: its branch, the run on it, and what changed in its files since the commit.
export function SandboxPage() {
  const id = useParams().id ?? ''
  const navigate = useNavigate()
  const now = useNow()
  const sandbox = useApi<SandboxView>(`/sandboxes/${encodeURIComponent(id)}`)
  // the changes are read while no run holds the sandbox
  const free = sandbox.data !== undefined && !sandbox.data.busy
  const changes = useApi<{ commit: string; files: ChangedFile[] }>(`/sandboxes/${encodeURIComponent(id)}/changes`, {
    enabled: free,
  })
  const diff = useApiText(`/sandboxes/${encodeURIComponent(id)}/changes?format=diff`, {
    enabled: free && (changes.data?.files.length ?? 0) > 0,
  })
  return (
    <>
      <PageTitle>{id}</PageTitle>
      <Loading query={sandbox} missing={<Empty>There is no such sandbox of yours.</Empty>}>
        {(found) => {
          const facts: [ReactNode, ReactNode][] = [
            ['Repository', <T>{found.repo}</T>],
            ['Branch', <Branch sandbox={found} />],
            ['Size', formatMemory(found.bytes)],
            ['Created', <Time iso={found.createdAt} now={now} />],
            ['Last used', <Time iso={found.lastUsedAt} now={now} />],
            ['Run', found.run ? <RunLink id={found.run} /> : <Quiet>none works on it</Quiet>],
          ]
          return (
            <>
              <Card className="mb-6 flex items-start gap-4">
                <div className="min-w-0 flex-1">
                  <Facts items={facts} />
                </div>
                <DeleteButton sandbox={found} onDone={() => navigate('/sandboxes')} />
              </Card>
              <Section title="Changes" note={changes.data ? plural(changes.data.files.length, 'file') : undefined}>
                {found.busy ? (
                  <Empty>A run works on it: the changes show once it is over.</Empty>
                ) : (
                  <Loading query={changes}>
                    {({ files }) =>
                      files.length === 0 ? (
                        <Empty>Nothing changed since {found.commit.slice(0, 12)}.</Empty>
                      ) : (
                        <>
                          <Table head={['File', 'Change', '+', '−']} right={[false, false, true, true]}>
                            {files.map((file) => (
                              <tr key={file.path}>
                                <Td>
                                  <Code>{file.path}</Code>
                                  {file.from ? (
                                    <div className="text-xs text-stone-500 dark:text-stone-400">
                                      from <Code>{file.from}</Code>
                                    </div>
                                  ) : null}
                                </Td>
                                <Td className={CHANGE_STYLES[file.status] ?? ''}>{file.status}</Td>
                                <Td num className="text-emerald-700 dark:text-emerald-400">
                                  {file.additions ?? ''}
                                </Td>
                                <Td num className="text-red-700 dark:text-red-400">
                                  {file.deletions ?? ''}
                                </Td>
                              </tr>
                            ))}
                          </Table>
                          <Loading query={diff}>{(text) => <Diff text={text} />}</Loading>
                        </>
                      )
                    }
                  </Loading>
                )}
              </Section>
            </>
          )
        }}
      </Loading>
    </>
  )
}

// A unified diff, its added lines green, its removed ones red.
function Diff({ text }: { text: string }) {
  return (
    <pre className="log mt-4 whitespace-pre-wrap">
      {text.split('\n').map((line, index) => (
        <div
          key={index}
          className={
            line.startsWith('+') && !line.startsWith('+++')
              ? 'text-emerald-400'
              : line.startsWith('-') && !line.startsWith('---')
                ? 'text-red-400'
                : line.startsWith('@@')
                  ? 'text-sky-400'
                  : ''
          }
        >
          {printable(line) || ' '}
        </div>
      ))}
    </pre>
  )
}
