import { useState, type ReactNode } from 'react'
import { hashPath, useApi, type TaskPlan } from './api'
import type { Bundle } from '../../src/remote/bundle'
import type { DefinitionVersion } from '../../src/server/definitions'
import { printable } from './format'
import { FileTree, TreeLayout, useOpenFile } from './file-tree'
import { ADDED_LINE, Code, Empty, inputClass, Loading, Quiet, REMOVED_LINE } from './ui'

// What the list of build files tells of a version, as far as a comparison needs it.
interface PublishedVersion {
  hash: string
  entry: string
  publishedAt: string
  annotations: Record<string, string>
  yanked?: unknown
}

// The version a comparison starts from: the newest published one of the same build file
// (repository and path), else the newest of the repository, else the newest of all.
function pickBase(versions: PublishedVersion[], hash: string, repo?: string, path?: string): string | undefined {
  const others = versions
    .filter((version) => version.hash !== hash && !version.yanked)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
  const pathOf = (version: PublishedVersion) => version.annotations.path ?? version.entry
  return (
    others.find((version) => version.annotations.repo === repo && pathOf(version) === path) ??
    others.find((version) => version.annotations.repo === repo) ??
    others[0]
  )?.hash
}

const short = (hash: string) => hash.replace(/^sha256:/, '').slice(0, 12)

// How a version compares with another one the person picks: the tasks and services added,
// removed and changed (what changed in each), and the lines of the build files.
export function CompareVersions({
  hash,
  plan,
  files,
  repo,
  path,
}: {
  hash: string
  plan: Record<string, TaskPlan>
  // the version's files; none when the server no longer keeps them
  files?: Record<string, string>
  repo?: string
  path?: string
}) {
  const list = useApi<{ definitions: PublishedVersion[] }>('/definitions', { refresh: false })
  const [picked, setPicked] = useState<string | null>(null)
  const versions = list.data?.definitions ?? []
  const base = picked ?? pickBase(versions, hash, repo, path)
  const other = useApi<DefinitionVersion>(`/definitions/${hashPath(base ?? '')}`, { enabled: !!base, refresh: false })
  const otherFiles = useApi<Bundle>(`/definitions/${hashPath(base ?? '')}/files`, {
    enabled: !!base && !!files,
    refresh: false,
  })
  const choices = versions
    .filter((version) => version.hash !== hash)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
  return (
    <Loading query={list}>
      {() =>
        choices.length === 0 ? (
          <Empty>No other version is published to compare with.</Empty>
        ) : (
          <>
            <label className="mb-4 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-stone-600 dark:text-stone-300">Compared with</span>
              <select
                className={`${inputClass} min-w-0 flex-1 sm:max-w-xl`}
                value={base ?? ''}
                onChange={(e) => setPicked(e.target.value)}
              >
                {choices.map((version) => (
                  <option key={version.hash} value={version.hash}>
                    {[
                      version.annotations.repo,
                      version.annotations.path ?? version.entry,
                      version.annotations.commit ? `at ${version.annotations.commit.slice(0, 12)}` : '',
                      short(version.hash),
                      new Date(version.publishedAt).toLocaleString(),
                      version.yanked ? '(yanked)' : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </option>
                ))}
              </select>
            </label>
            <Loading query={other}>
              {(found) => (
                <>
                  <h3 className="mb-2 text-sm font-medium">Tasks and services</h3>
                  {found.plan ? (
                    <PlanChanges before={found.plan} after={plan} />
                  ) : (
                    <Empty>That version was published before the server kept what it runs.</Empty>
                  )}
                  <h3 className="mt-6 mb-2 text-sm font-medium">Files</h3>
                  {files ? (
                    <Loading query={otherFiles}>
                      {(bundle) => <FileChanges before={bundle.files} after={files} />}
                    </Loading>
                  ) : (
                    <Empty>The files of this version are no longer kept.</Empty>
                  )}
                </>
              )}
            </Loading>
          </>
        )
      }
    </Loading>
  )
}

// a value of a plan as one line, the way a change shows it
function shown(value: unknown): string {
  if (value === undefined) {
    return '—'
  }
  return printable(typeof value === 'string' ? value : JSON.stringify(value))
}

// what is not a change of what a task does: where it is declared, and the server's own notes
const IGNORED = new Set(['file', 'flags'])

function PlanChanges({ before, after }: { before: Record<string, TaskPlan>; after: Record<string, TaskPlan> }) {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  const rows: ReactNode[] = []
  for (const name of names) {
    const old = before[name] as unknown as Record<string, unknown> | undefined
    const now = after[name] as unknown as Record<string, unknown> | undefined
    if (!old || !now) {
      rows.push(
        <li key={name} className={now ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}>
          {now ? '+ ' : '− '}
          <Code>{name}</Code> <Quiet>{now ? 'added' : 'removed'}</Quiet>
        </li>
      )
      continue
    }
    const keys = [...new Set([...Object.keys(old), ...Object.keys(now)])]
      .filter((key) => !IGNORED.has(key) && JSON.stringify(old[key]) !== JSON.stringify(now[key]))
      .sort()
    if (keys.length > 0) {
      rows.push(
        <li key={name}>
          ~ <Code>{name}</Code> <Quiet>changed</Quiet>
          <dl className="mt-1 mb-2 ml-4 grid grid-cols-[minmax(5rem,auto)_1fr] gap-x-3 gap-y-1 text-xs">
            {keys.map((key) => (
              <div key={key} className="contents">
                <dt className="text-stone-500 dark:text-stone-400">{key}</dt>
                <dd className="min-w-0 font-mono [overflow-wrap:anywhere]">
                  <div className="text-red-700 dark:text-red-400">− {shown(old[key])}</div>
                  <div className="text-emerald-700 dark:text-emerald-400">+ {shown(now[key])}</div>
                </dd>
              </div>
            ))}
          </dl>
        </li>
      )
    }
  }
  return rows.length === 0 ? (
    <Quiet>
      <span className="text-sm">Every task and service is the same.</span>
    </Quiet>
  ) : (
    <ul className="flex flex-col gap-1 text-sm">{rows}</ul>
  )
}

// The changed files as a tree, as a sandbox's changes show, and the diff of the open one
// (`?compare=`).
function FileChanges({ before, after }: { before: Record<string, string>; after: Record<string, string> }) {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  const changed = names
    .filter((name) => before[name] !== after[name])
    .map((path) => ({
      path,
      status: before[path] === undefined ? 'added' : after[path] === undefined ? 'removed' : 'changed',
      lines: diffLines(before[path] ?? '', after[path] ?? ''),
    }))
  const [open, setOpen] = useOpenFile(
    changed.map((file) => file.path),
    'compare'
  )
  const shownFile = changed.find((file) => file.path === open)
  if (!shownFile) {
    return (
      <Quiet>
        <span className="text-sm">Every file is the same.</span>
      </Quiet>
    )
  }
  return (
    <TreeLayout
      tree={
        <FileTree
          items={changed}
          open={open}
          onOpen={setOpen}
          className={(file) => STATUS_STYLES[file.status] ?? ''}
          extra={(file) =>
            file.lines ? (
              <>
                <span className="text-emerald-700 dark:text-emerald-400">
                  +{file.lines.filter((line) => line.kind === '+').length}
                </span>{' '}
                <span className="text-red-700 dark:text-red-400">
                  −{file.lines.filter((line) => line.kind === '-').length}
                </span>
              </>
            ) : null
          }
        />
      }
    >
      <div className="mb-2 flex flex-wrap items-baseline gap-2 text-sm">
        <Code>{shownFile.path}</Code>
        <span className={STATUS_STYLES[shownFile.status] ?? ''}>{shownFile.status}</span>
      </div>
      <LineDiff lines={shownFile.lines} />
    </TreeLayout>
  )
}

const STATUS_STYLES: Record<string, string> = {
  added: 'text-emerald-700 dark:text-emerald-400',
  removed: 'text-red-700 dark:text-red-400',
}

// the most lines a file may have on both sides together for a line by line comparison
const MAX_CELLS = 4_000_000
// lines kept around a change
const CONTEXT = 3

type Line = { kind: ' ' | '+' | '-'; text: string }

// The lines of two texts as a unified diff: the longest common subsequence, then what is
// around each change.
function diffLines(before: string, after: string): Line[] | undefined {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  if (a.length * b.length > MAX_CELLS) {
    return undefined
  }
  const width = b.length + 1
  const lengths = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i * width + j] =
        a[i] === b[j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1])
    }
  }
  const lines: Line[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ kind: ' ', text: a[i] })
      i++
      j++
    } else if (j < b.length && (i === a.length || lengths[i * width + j + 1] >= lengths[(i + 1) * width + j])) {
      lines.push({ kind: '+', text: b[j++] })
    } else {
      lines.push({ kind: '-', text: a[i++] })
    }
  }
  return lines
}

function LineDiff({ lines }: { lines: Line[] | undefined }) {
  if (!lines) {
    return <Empty>Too large to compare line by line.</Empty>
  }
  // only what is near a change, a gap marked between
  const near = new Set<number>()
  lines.forEach((line, index) => {
    if (line.kind !== ' ') {
      for (let k = Math.max(0, index - CONTEXT); k <= Math.min(lines.length - 1, index + CONTEXT); k++) {
        near.add(k)
      }
    }
  })
  const out: ReactNode[] = []
  let gap = false
  lines.forEach((line, index) => {
    if (!near.has(index)) {
      gap = true
      return
    }
    if (gap && out.length > 0) {
      out.push(
        <div key={`gap${index}`} className="text-sky-400">
          ⋯
        </div>
      )
    }
    gap = false
    out.push(
      <div key={index} className={line.kind === '+' ? ADDED_LINE : line.kind === '-' ? REMOVED_LINE : ''}>
        {line.kind} {printable(line.text) || ' '}
      </div>
    )
  })
  return <pre className="log whitespace-pre-wrap">{out}</pre>
}
