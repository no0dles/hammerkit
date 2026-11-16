import { useEffect, useRef, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { useApi, type TaskPlan } from './api'
import { plural, printable } from './format'
import { FileTree, TreeLayout, useOpenFile } from './file-tree'
import { ADDED_LINE, Code, Empty, inputClass, Quiet, REMOVED_LINE } from './ui'

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

// What a comparison is against, as the address names it (`?base=`): that version, else the one
// `pickBase` finds; with every other published version to pick from instead, newest first.
export function useCompareBase(hash: string, repo?: string, path?: string) {
  const [params, setParams] = useSearchParams()
  const list = useApi<{ definitions: PublishedVersion[] }>('/definitions', { refresh: false })
  const versions = list.data?.definitions ?? []
  const choices = versions
    .filter((version) => version.hash !== hash)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
  const asked = params.get('base')
  const base = choices.some((version) => version.hash === asked) ? asked! : pickBase(versions, hash, repo, path)
  const setBase = (next: string) => {
    const changed = new URLSearchParams(params)
    changed.set('base', next)
    setParams(changed, { replace: true })
  }
  return { list, choices, base, setBase }
}

// The version a comparison is against, to pick another.
export function BaseSelect({
  choices,
  base,
  onChange,
}: {
  choices: PublishedVersion[]
  base: string | undefined
  onChange: (hash: string) => void
}) {
  if (choices.length === 0) {
    return <Quiet>No other version is published to compare with.</Quiet>
  }
  return (
    <label className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-stone-600 dark:text-stone-300">Compared with</span>
      <select
        className={`${inputClass} min-w-0 flex-1 sm:max-w-xl`}
        value={base ?? ''}
        onChange={(e) => onChange(e.target.value)}
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
  )
}

// what is not a change of what a task does: where it is declared, and the server's own notes
const IGNORED = new Set(['file', 'flags'])

export type PlanStatus = 'added' | 'changed' | 'unchanged'

// Each task and service of `after` as added, changed or unchanged against `before`, and the
// names `after` no longer has.
export function planChanges(
  before: Record<string, TaskPlan>,
  after: Record<string, TaskPlan>
): { status: Record<string, PlanStatus>; removed: string[] } {
  const status: Record<string, PlanStatus> = {}
  for (const [name, entry] of Object.entries(after)) {
    const old = before[name] as unknown as Record<string, unknown> | undefined
    const now = entry as unknown as Record<string, unknown>
    status[name] = !old
      ? 'added'
      : [...new Set([...Object.keys(old), ...Object.keys(now)])].some(
            (key) => !IGNORED.has(key) && JSON.stringify(old[key]) !== JSON.stringify(now[key])
          )
        ? 'changed'
        : 'unchanged'
  }
  return {
    status,
    removed: Object.keys(before)
      .filter((name) => !(name in after))
      .sort(),
  }
}

// The files of a version against those of another (none: nothing to compare with): every file as
// a tree, the added, removed and changed ones marked with what they add and remove, and the open
// one as a diff, or as it is when it did not change. The open one is the first changed one unless
// the address names another (`?file=`); `?at=` names a task whose line is shown and marked.
export function CompareFiles({
  before,
  after,
}: {
  before: Record<string, string> | undefined
  after: Record<string, string>
}) {
  const all = [...new Set([...Object.keys(before ?? after), ...Object.keys(after)])].sort().map((path) => {
    const status = !before
      ? 'same'
      : before[path] === undefined
        ? 'added'
        : after[path] === undefined
          ? 'removed'
          : before[path] === after[path]
            ? 'same'
            : 'changed'
    return {
      path,
      status,
      lines: status === 'same' ? undefined : diffLines(before?.[path] ?? '', after[path] ?? ''),
    }
  })
  const firstChanged = all.find((file) => file.status !== 'same')?.path
  const [asked, setOpen] = useOpenFile(all.map((file) => file.path))
  const [params] = useSearchParams()
  const open = params.get('file') !== null ? asked : firstChanged ?? asked
  const at = params.get('at')
  const shownFile = all.find((file) => file.path === open)
  if (!shownFile) {
    return <Quiet>No files.</Quiet>
  }
  const changes = all.filter((file) => file.status !== 'same').length
  const text = after[shownFile.path] ?? before?.[shownFile.path] ?? ''
  return (
    <>
      {before ? (
        <p className="mb-2 text-sm text-stone-500 dark:text-stone-400">
          {changes === 0 ? 'No file changed.' : `${plural(changes, 'file')} changed.`}
        </p>
      ) : null}
      <TreeLayout
        tree={
          <FileTree
            items={all}
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
              ) : file.status === 'same' ? null : (
                <Quiet>large</Quiet>
              )
            }
          />
        }
      >
        <div className="mb-2 flex flex-wrap items-baseline gap-2 text-sm">
          <Code>{shownFile.path}</Code>
          {shownFile.status === 'same' ? (
            <Quiet>
              {before ? 'unchanged, ' : ''}
              {text.split('\n').length} lines
            </Quiet>
          ) : (
            <span className={STATUS_STYLES[shownFile.status] ?? ''}>{shownFile.status}</span>
          )}
        </div>
        <LineDiff
          key={`${shownFile.path}:${at ?? ''}`}
          lines={shownFile.lines ?? text.split('\n').map((line) => ({ kind: ' ', text: line }))}
          whole={shownFile.status === 'same'}
          focus={at ? declares(at) : undefined}
        />
      </TreeLayout>
    </>
  )
}

// whether a line declares the task or service of that local name (`  deploy-api:`)
function declares(name: string): (text: string) => boolean {
  const local = name.split(':').pop() ?? name
  return (text) => {
    const trimmed = text.trim()
    return /^\s/.test(text) && (trimmed === `${local}:` || trimmed === `'${local}':` || trimmed === `"${local}":`)
  }
}

const STATUS_STYLES: Record<string, string> = {
  added: 'text-emerald-700 dark:text-emerald-400',
  removed: 'text-red-700 dark:text-red-400',
  changed: 'text-amber-700 dark:text-amber-400',
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

// A diff, only what is near a change unless `whole`; the line `focus` finds first is kept,
// marked and scrolled to.
function LineDiff({
  lines,
  whole = false,
  focus,
}: {
  lines: Line[] | undefined
  whole?: boolean
  focus?: (text: string) => boolean
}) {
  const marked = useRef<HTMLDivElement>(null)
  useEffect(() => {
    marked.current?.scrollIntoView({ block: 'center' })
  }, [])
  if (!lines) {
    return <Empty>Too large to compare line by line.</Empty>
  }
  const target = focus ? lines.findIndex((line) => line.kind !== '-' && focus(line.text)) : -1
  // only what is near a change or the marked line, a gap marked between
  const near = new Set<number>()
  lines.forEach((line, index) => {
    if (whole || line.kind !== ' ' || index === target) {
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
    const style = line.kind === '+' ? ADDED_LINE : line.kind === '-' ? REMOVED_LINE : ''
    out.push(
      <div
        key={index}
        ref={index === target ? marked : undefined}
        className={index === target ? `${style} outline-1 outline-amber-400` : style}
      >
        {whole ? '' : `${line.kind} `}
        {printable(line.text) || ' '}
      </div>
    )
  })
  return <pre className="log whitespace-pre-wrap">{out}</pre>
}
