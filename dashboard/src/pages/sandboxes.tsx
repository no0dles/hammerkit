import { Fragment, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { remove, useAction, useApi, useApiText, useSession, type ListedRun } from '../api'
import type { Sandbox } from '../../../src/server/sandboxes'
import type { ChangedFile } from '../../../src/server/sandbox-files'
import { formatMemory, printable } from '../format'
import { countOptions, FilterPill, readChosen, writeChosen } from '../filter-pill'
import {
  Card,
  Code,
  Empty,
  ErrorNote,
  Facts,
  Loading,
  PageTitle,
  Person,
  Quiet,
  PageTabs,
  RunLink,
  StateMark,
  T,
  Table,
  Td,
  Time,
  useNow,
  WebLink,
  Work,
} from '../ui'
import { webLinks } from '../../../src/utils/web-links'

// A sandbox as the API shows it: and the run that works on it now, if one does. One of
// somebody else (shown to who observes) names its owner; one's own does not.
type SandboxView = Omit<Sandbox, 'owner'> & {
  owner?: { iss: string; sub: string; name?: string }
  busy: boolean
  run: string | null
}

interface SandboxList {
  sandboxes: SandboxView[]
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
  const links = webLinks(sandbox.repo)
  // its own branch pushed at the commit it is at says no more than "pushed"
  const upToDate = sandbox.pushed?.[sandbox.ref] === sandbox.commit
  const pushed = Object.entries(sandbox.pushed ?? {}).filter(
    ([branch, commit]) => branch !== sandbox.ref || commit !== sandbox.commit
  )
  return (
    <>
      <WebLink href={links?.ref?.(sandbox.ref)}>
        <Code className="break-normal">{sandbox.ref}</Code>
      </WebLink>
      <div className="text-xs text-stone-500 dark:text-stone-400">
        at{' '}
        <WebLink href={links?.commit?.(sandbox.commit)}>
          <Code className="break-normal">{sandbox.commit.slice(0, 12)}</Code>
        </WebLink>
        {upToDate ? ', pushed' : null}
      </div>
      {pushed.length > 0 ? (
        <div className="text-xs text-stone-500 dark:text-stone-400">
          pushed{' '}
          {pushed.map(([branch, commit], index) => (
            <Fragment key={branch}>
              {index > 0 ? ', ' : ''}
              {/* its own branch goes without its name, which is right above */}
              {branch === sandbox.ref ? null : (
                <>
                  <WebLink href={links?.ref?.(branch)}>
                    <Code>{branch}</Code>
                  </WebLink>{' '}
                </>
              )}
              <Quiet>at</Quiet>{' '}
              <WebLink href={links?.commit?.(commit)}>
                <Code>{commit.slice(0, 12)}</Code>
              </WebLink>
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

type FilterKey = 'owner' | 'repo' | 'ref'

// whose a sandbox is, as the owner filter names it
function ownerOf(sandbox: SandboxView): string {
  return sandbox.owner ? sandbox.owner.name ?? sandbox.owner.sub : 'you'
}

// what the sandboxes can be narrowed by, as the address names it: whose, and what they were made from
const FILTERS: [FilterKey, string, (sandbox: SandboxView) => string[]][] = [
  ['owner', 'Owner', (sandbox) => [ownerOf(sandbox)]],
  ['repo', 'Repository', (sandbox) => [sandbox.repo]],
  ['ref', 'Branch', (sandbox) => [sandbox.ref]],
]

// The checkouts on the server that runs work on: the person's own, or, for who observes,
// everybody's, theirs among them, which the owner filter narrows.
export function SandboxesPage() {
  const [params, setParams] = useSearchParams()
  const all = useSession().data?.observe ?? false
  const list = useApi<SandboxList>(all ? '/sandboxes?scope=all' : '/sandboxes')
  const now = useNow()
  // whose they are only narrows everybody's
  const filters = FILTERS.filter(([key]) => all || key !== 'owner')
  const chosen = Object.fromEntries(FILTERS.map(([key]) => [key, readChosen(params, key)])) as Record<
    FilterKey,
    string[]
  >
  const columns = all ? 7 : 6
  return (
    <>
      <PageTitle>Sandboxes</PageTitle>
      <Loading query={list} missing={<Empty>This server keeps no sandboxes.</Empty>}>
        {({ sandboxes }) => {
          const shown = sandboxes.filter((sandbox) =>
            filters.every(
              ([key, , of]) => chosen[key].length === 0 || of(sandbox).some((value) => chosen[key].includes(value))
            )
          )
          return (
            <>
              {sandboxes.length > 0 ? (
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  {filters.map(([key, name, of]) => (
                    <FilterPill
                      key={key}
                      name={name}
                      options={countOptions(sandboxes, of)}
                      chosen={chosen[key]}
                      onChange={(next) => setParams(writeChosen(params, key, next), { replace: true })}
                    />
                  ))}
                </div>
              ) : null}
              {shown.length === 0 ? (
                <Empty>
                  {sandboxes.length > 0
                    ? 'No sandbox is like that.'
                    : all
                      ? 'There is no sandbox on this server.'
                      : 'You have no sandbox on this server.'}
                </Empty>
              ) : (
                <Table
                  head={['Sandbox', 'Branch', ...(all ? ['Owner'] : []), 'Size', 'Last used', 'Created', '']}
                  right={[false, false, ...(all ? [false] : []), true, true, true, true]}
                >
                  {byRepo(shown).map(([repo, group]) => (
                    <Fragment key={repo}>
                      <tr className="bg-stone-50 dark:bg-stone-950/40">
                        <th
                          colSpan={columns}
                          scope="colgroup"
                          className="px-3 py-1.5 text-left text-xs font-medium text-stone-600 dark:text-stone-300"
                        >
                          <WebLink href={webLinks(repo)?.repo}>
                            <T>{repo}</T>
                          </WebLink>
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
                          {all ? (
                            <Td className="whitespace-nowrap">
                              {sandbox.owner ? <Person who={sandbox.owner} /> : <Quiet>you</Quiet>}
                            </Td>
                          ) : null}
                          <Td num>{formatMemory(sandbox.bytes)}</Td>
                          <Td num>
                            <Time iso={sandbox.lastUsedAt} now={now} />
                          </Td>
                          <Td num>
                            <Time iso={sandbox.createdAt} now={now} />
                          </Td>
                          <Td className="text-right">
                            {/* somebody else's is theirs to delete */}
                            {sandbox.owner ? null : <DeleteButton sandbox={sandbox} />}
                          </Td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </Table>
              )}
            </>
          )
        }}
      </Loading>
    </>
  )
}

const CHANGE_STYLES: Record<string, string> = {
  added: 'text-emerald-700 dark:text-emerald-400',
  deleted: 'text-red-700 dark:text-red-400',
}

type DetailTab = 'changes' | 'runs'

// One sandbox: its branch, the run on it, and what changed in its files since the commit. One
// of somebody else, which who observes reads, shows the same and changes nothing.
export function SandboxPage() {
  const id = useParams().id ?? ''
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const tab: DetailTab = params.get('tab') === 'runs' ? 'runs' : 'changes'
  const setTab = (next: DetailTab) => {
    const changed = new URLSearchParams(params)
    if (next === 'changes') {
      changed.delete('tab')
    } else {
      changed.set('tab', next)
    }
    setParams(changed, { replace: true })
  }
  const now = useNow()
  const observes = useSession().data?.observe ?? false
  const sandbox = useApi<SandboxView>(`/sandboxes/${encodeURIComponent(id)}`)
  // the changes are read while no run holds the sandbox
  const free = sandbox.data !== undefined && !sandbox.data.busy
  const changes = useApi<{ commit: string; files: ChangedFile[] }>(`/sandboxes/${encodeURIComponent(id)}/changes`, {
    enabled: free,
  })
  // one file's diff at a time: the one the address names, else the first
  const files = changes.data?.files ?? []
  const open = files.find((file) => file.path === params.get('file')) ?? files[0]
  const diffQuery = new URLSearchParams({ format: 'diff' })
  for (const path of open ? [open.path, ...(open.from ? [open.from] : [])] : []) {
    diffQuery.append('path', path)
  }
  const diff = useApiText(`/sandboxes/${encodeURIComponent(id)}/changes?${diffQuery}`, {
    enabled: free && open !== undefined,
  })
  // every run that worked on it, newest first
  const runs = useApi<{ runs: ListedRun[] }>(
    `/runs?${new URLSearchParams({ scope: observes ? 'all' : 'mine', sandbox: id })}`
  )
  return (
    <>
      <PageTitle>{id}</PageTitle>
      <Loading
        query={sandbox}
        missing={<Empty>{observes ? 'There is no such sandbox.' : 'There is no such sandbox of yours.'}</Empty>}
      >
        {(found) => {
          const facts: [ReactNode, ReactNode][] = [
            [
              'Repository',
              <WebLink href={webLinks(found.repo)?.repo}>
                <T>{found.repo}</T>
              </WebLink>,
            ],
            ['Branch', <Branch sandbox={found} />],
            ...(found.owner ? [['Owner', <Person who={found.owner} />] as [ReactNode, ReactNode]] : []),
            ['Size', formatMemory(found.bytes)],
            ['Created', <Time iso={found.createdAt} now={now} />],
            ['Last used', <Time iso={found.lastUsedAt} now={now} />],
            ['Run', found.run ? <RunLink id={found.run} /> : <Quiet>none works on it</Quiet>],
          ]
          return (
            <>
              {found.owner ? (
                <p className="mb-4 rounded-lg border border-sky-200 bg-sky-50 px-4 py-2 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200">
                  A sandbox of <Person who={found.owner} />. You see it because you observe this server: you can read
                  it, but not change or delete it.
                </p>
              ) : null}
              <Card className="mb-6 flex items-start gap-4">
                <div className="min-w-0 flex-1">
                  <Facts items={facts} />
                </div>
                {found.owner ? null : <DeleteButton sandbox={found} onDone={() => navigate('/sandboxes')} />}
              </Card>
              <PageTabs
                label="What the sandbox shows"
                tabs={[
                  {
                    key: 'changes',
                    name: 'Changes',
                    note: changes.data ? changes.data.files.length : undefined,
                  },
                  { key: 'runs', name: 'Runs', note: runs.data ? runs.data.runs.length : undefined },
                ]}
                current={tab}
                onChange={setTab}
              />
              {tab === 'runs' ? (
                <>
                  <Loading query={runs}>
                    {({ runs: list }) =>
                      list.length === 0 ? (
                        <Empty>No run worked on it.</Empty>
                      ) : (
                        <Table head={['Run', 'Tasks', 'Created']} right={[false, false, true]}>
                          {list.map((run) => (
                            <tr key={run.id}>
                              <Td className="whitespace-nowrap">
                                <div className="flex items-start gap-2">
                                  <StateMark state={run.state} />
                                  <div>
                                    <RunLink id={run.id} />
                                    <div className="text-xs text-stone-500 dark:text-stone-400">{run.state}</div>
                                  </div>
                                </div>
                              </Td>
                              <Td>
                                <Work run={run} />
                              </Td>
                              <Td num>
                                <Time iso={run.createdAt} now={now} />
                              </Td>
                            </tr>
                          ))}
                        </Table>
                      )
                    }
                  </Loading>
                </>
              ) : (
                <>
                  {found.busy ? (
                    <Empty>A run works on it: the changes show once it is over.</Empty>
                  ) : (
                    <Loading query={changes}>
                      {({ files: changed }) =>
                        changed.length === 0 || !open ? (
                          <Empty>Nothing changed since {found.commit.slice(0, 12)}.</Empty>
                        ) : (
                          <div className="grid gap-4 md:grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)]">
                            <ChangedTree
                              files={changed}
                              open={open.path}
                              onOpen={(path) => {
                                const next = new URLSearchParams(params)
                                next.set('file', path)
                                setParams(next, { replace: true })
                              }}
                            />
                            <div className="min-w-0">
                              <div className="mb-2 flex flex-wrap items-baseline gap-2 text-sm">
                                <Code>{open.path}</Code>
                                {open.from ? (
                                  <Quiet>
                                    from <Code>{open.from}</Code>
                                  </Quiet>
                                ) : null}
                                <span className={CHANGE_STYLES[open.status] ?? ''}>{open.status}</span>
                              </div>
                              <Loading query={diff}>
                                {(text) =>
                                  text ? (
                                    <Diff text={onlyFile(text, open.path)} />
                                  ) : (
                                    <Empty>No lines to show: its mode or kind changed.</Empty>
                                  )
                                }
                              </Loading>
                            </div>
                          </div>
                        )
                      }
                    </Loading>
                  )}
                </>
              )}
            </>
          )
        }}
      </Loading>
    </>
  )
}

interface TreeNode {
  name: string
  dirs: Map<string, TreeNode>
  files: ChangedFile[]
}

// the changed files as directories and files, each directory with only one directory in it
// shown as one (`src/server`)
function toTree(files: ChangedFile[]): TreeNode {
  const root: TreeNode = { name: '', dirs: new Map(), files: [] }
  for (const file of files) {
    const parts = file.path.split('/')
    let node = root
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.get(part)
      if (!next) {
        next = { name: part, dirs: new Map(), files: [] }
        node.dirs.set(part, next)
      }
      node = next
    }
    node.files.push(file)
  }
  const squash = (node: TreeNode): TreeNode => {
    for (const [key, dir] of node.dirs) {
      let merged = dir
      while (merged.files.length === 0 && merged.dirs.size === 1) {
        const [only] = merged.dirs.values()
        merged = { ...only, name: `${merged.name}/${only.name}` }
      }
      node.dirs.set(key, squash(merged))
    }
    return node
  }
  return squash(root)
}

// The changed files as a tree, the open one marked; a click opens another.
function ChangedTree({ files, open, onOpen }: { files: ChangedFile[]; open: string; onOpen: (path: string) => void }) {
  const level = (node: TreeNode, depth: number): ReactNode => (
    <>
      {[...node.dirs.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((dir) => (
          <Fragment key={`d:${dir.name}`}>
            <li
              className="truncate py-0.5 text-stone-500 dark:text-stone-400"
              style={{ paddingLeft: `${depth * 0.75}rem` }}
              title={dir.name}
            >
              {dir.name}/
            </li>
            {level(dir, depth + 1)}
          </Fragment>
        ))}
      {[...node.files]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((file) => {
          const on = file.path === open
          return (
            <li key={file.path} style={{ paddingLeft: `${depth * 0.75}rem` }}>
              <button
                type="button"
                aria-current={on ? 'true' : undefined}
                onClick={() => onOpen(file.path)}
                title={file.path}
                className={`flex w-full cursor-pointer items-baseline gap-2 rounded px-1.5 py-0.5 text-left ${
                  on
                    ? 'bg-emerald-50 font-medium text-stone-900 dark:bg-emerald-950 dark:text-white'
                    : 'hover:bg-stone-100 dark:hover:bg-stone-800'
                }`}
              >
                <span className={`min-w-0 flex-1 truncate ${CHANGE_STYLES[file.status] ?? ''}`}>
                  {file.path.split('/').pop()}
                </span>
                <span className="shrink-0 text-xs tabular-nums">
                  {file.additions !== null ? (
                    <span className="text-emerald-700 dark:text-emerald-400">+{file.additions}</span>
                  ) : null}{' '}
                  {file.deletions !== null ? (
                    <span className="text-red-700 dark:text-red-400">−{file.deletions}</span>
                  ) : null}
                </span>
              </button>
            </li>
          )
        })}
    </>
  )
  return (
    <nav aria-label="Changed files" className="md:sticky md:top-4 md:max-h-[80vh] md:overflow-y-auto">
      <ul className="font-mono text-[0.8rem]">{level(toTree(files), 0)}</ul>
    </nav>
  )
}

// The part of a diff about one file: a server whose sandbox pods are older answers the diff
// of every file, whatever the request named.
function onlyFile(text: string, path: string): string {
  const parts = text.split(/^(?=diff --git )/m)
  const mine = parts.filter((part) => part.split('\n', 1)[0].endsWith(` b/${path}`))
  return mine.length > 0 ? mine.join('') : text
}

// A unified diff, its added lines green, its removed ones red.
function Diff({ text }: { text: string }) {
  return (
    <pre className="log whitespace-pre-wrap">
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
