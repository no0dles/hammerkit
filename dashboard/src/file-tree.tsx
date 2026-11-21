import { Fragment, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { printable } from './format'
import { Code, Quiet } from './ui'

interface TreeNode<T> {
  name: string
  dirs: Map<string, TreeNode<T>>
  files: T[]
}

// the files as directories and files, each directory with only one directory in it shown as
// one (`src/server`)
function toTree<T extends { path: string }>(items: T[]): TreeNode<T> {
  const root: TreeNode<T> = { name: '', dirs: new Map(), files: [] }
  for (const item of items) {
    let node = root
    for (const part of item.path.split('/').slice(0, -1)) {
      let next = node.dirs.get(part)
      if (!next) {
        next = { name: part, dirs: new Map(), files: [] }
        node.dirs.set(part, next)
      }
      node = next
    }
    node.files.push(item)
  }
  const squash = (node: TreeNode<T>): TreeNode<T> => {
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

// Files as a tree, the open one marked; a click opens another. `className` styles a file's
// name, `extra` is what shows at its right.
export function FileTree<T extends { path: string }>({
  items,
  open,
  onOpen,
  className,
  extra,
}: {
  items: T[]
  open: string | undefined
  onOpen: (path: string) => void
  className?: (item: T) => string
  extra?: (item: T) => ReactNode
}) {
  const level = (node: TreeNode<T>, depth: number): ReactNode => (
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
        .map((item) => {
          const on = item.path === open
          return (
            <li key={item.path} style={{ paddingLeft: `${depth * 0.75}rem` }}>
              <button
                type="button"
                aria-current={on ? 'true' : undefined}
                onClick={() => onOpen(item.path)}
                title={item.path}
                className={`flex w-full cursor-pointer items-baseline gap-2 rounded px-1.5 py-0.5 text-left ${
                  on
                    ? 'bg-emerald-50 font-medium text-stone-900 dark:bg-emerald-950 dark:text-white'
                    : 'hover:bg-stone-100 dark:hover:bg-stone-800'
                }`}
              >
                <span className={`min-w-0 flex-1 truncate ${className?.(item) ?? ''}`}>
                  {printable(item.path.split('/').pop() ?? item.path)}
                </span>
                {extra ? <span className="shrink-0 text-xs tabular-nums">{extra(item)}</span> : null}
              </button>
            </li>
          )
        })}
    </>
  )
  return (
    <nav aria-label="Files" className="md:sticky md:top-4 md:max-h-[80vh] md:overflow-y-auto">
      <ul className="font-mono text-[0.8rem]">{level(toTree(items), 0)}</ul>
    </nav>
  )
}

// The left tree and the right pane, side by side from a medium screen on.
export function TreeLayout({ tree, children }: { tree: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-4 md:grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)]">
      {tree}
      <div className="min-w-0">{children}</div>
    </div>
  )
}

// Which file is open, as the address names it (`?file=`, or another name where a page has two
// trees): that one, else the first.
export function useOpenFile(paths: string[], name = 'file'): [string | undefined, (path: string) => void] {
  const [params, setParams] = useSearchParams()
  const asked = params.get(name)
  const open = asked !== null && paths.includes(asked) ? asked : [...paths].sort()[0]
  const setOpen = (path: string) => {
    const next = new URLSearchParams(params)
    next.set(name, path)
    setParams(next, { replace: true })
  }
  return [open, setOpen]
}

// The files of a build file version: a tree, and the one open.
export function FileBrowser({ files }: { files: Record<string, string> }) {
  const paths = Object.keys(files)
  const [open, setOpen] = useOpenFile(paths)
  if (!open) {
    return <Quiet>No files.</Quiet>
  }
  const text = files[open]
  return (
    <TreeLayout
      tree={
        <FileTree
          items={paths.map((path) => ({ path }))}
          open={open}
          onOpen={setOpen}
          extra={({ path }) => <Quiet>{files[path].split('\n').length}</Quiet>}
        />
      }
    >
      <div className="mb-2 flex flex-wrap items-baseline gap-2 text-sm">
        <Code>{open}</Code>
        <Quiet>{text.split('\n').length} lines</Quiet>
      </div>
      <pre className="log">{printable(text)}</pre>
    </TreeLayout>
  )
}
