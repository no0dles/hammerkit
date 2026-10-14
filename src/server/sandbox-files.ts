import { spawn } from 'child_process'
import { createHash, randomBytes } from 'crypto'
import { constants, ReadStream } from 'fs'
import { chmod, FileHandle, lstat, mkdir, open, readlink, realpath, rename, rm, writeFile } from 'fs/promises'
import { dirname, join, normalize } from 'path'
import { Minimatch } from 'minimatch'
import { deniedSourcePath, MAX_SOURCE_FILE_BYTES } from '../remote/source-manifest'
import { FilePatch, parsePatch, PatchError } from './sandbox-patch'

// The largest file the API reads into memory, edits or writes: the limit of an upload.
export const MAX_FILE_BYTES = MAX_SOURCE_FILE_BYTES
// what one typed read answers at most
export const READ_LINES = 2000
const MAX_READ_LINES = 10_000
const MAX_READ_BYTES = 256 * 1024
const MAX_LINE_CHARS = 2000
const TREE_LIMIT = 1000
const MAX_TREE_LIMIT = 10_000
const SEARCH_LIMIT = 250
const MAX_SEARCH_LIMIT = 5000
// a search counts its results up to this many past the page, then stops ripgrep
const SEARCH_COUNT = 20_000
const SEARCH_TIMEOUT_MS = 60_000
// the most a diff or patch of the changes may take
export const MAX_CHANGES_BYTES = 64 * 1024 * 1024

export class SandboxFileError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 412 | 413 | 415 | 422 | 501 | 504,
    message: string,
    readonly details: { [key: string]: unknown } = {}
  ) {
    super(message)
  }
}

// `other` is a pipe, a socket or a device a task made: the API reads none of them
export type FileType = 'file' | 'directory' | 'symlink' | 'other'

export interface FileStat {
  path: string
  type: FileType
  size: number
  exec: boolean
  modifiedAt: string
  // where a symbolic link points; the API never follows it
  target?: string
}

export interface Page {
  // everything there is, the page included
  total: number
  // there is more after this page, ask again with `cursor`
  truncated: boolean
  cursor: string | null
}

export interface TreeQuery {
  path?: string
  depth?: number
  glob?: string
  limit?: number
  cursor?: string
}

export interface TreeEntry {
  path: string
  type: FileType
  size?: number
  target?: string
}

export interface TreeResult extends Page {
  path: string
  entries: TreeEntry[]
}

export interface ReadQuery {
  // the first line, 1 for the start of the file
  offset?: number
  limit?: number
}

export interface ReadResult {
  path: string
  sha256: string
  size: number
  // the lines of the whole file
  lines: number
  offset: number
  // the lines read, numbered like `cat -n`: the number right aligned in six places, a tab,
  // the line
  content: string
  // lines past the ones answered; `nextOffset` reads on
  truncated: boolean
  nextOffset: number | null
}

export interface RawFile {
  stat: FileStat
  // the bytes of a file up to MAX_FILE_BYTES, else a stream of them
  content?: Buffer
  sha256?: string
  stream?: ReadStream
}

export type SearchMode = 'files_with_matches' | 'content' | 'count'

// ripgrep's parameters, under the names models know from their grep tools
export interface SearchQuery {
  pattern: string
  path?: string
  glob?: string[]
  type?: string
  i?: boolean
  fixed_strings?: boolean
  multiline?: boolean
  A?: number
  B?: number
  C?: number
  output_mode?: SearchMode
  head_limit?: number
  cursor?: string
}

export interface SearchLine {
  path: string
  line: number
  text: string
  // a line around a match, not a match
  context?: true
}

export interface SearchResult extends Page {
  output_mode: SearchMode
  // false when ripgrep was stopped before it counted everything: `total` is at least this
  exact: boolean
  files?: string[]
  matches?: SearchLine[]
  counts?: { path: string; count: number }[]
}

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type'

export interface ChangedFile {
  path: string
  status: ChangeStatus
  from?: string
  // lines; none for a binary file
  additions: number | null
  deletions: number | null
}

export interface PatchAuthor {
  name: string
  email: string
  message: string
}

export type EditOp =
  | { op: 'replace'; path: string; old_string: string; new_string: string; replace_all?: boolean; ifHash?: string }
  | { op: 'write'; path: string; content: string | Buffer; encoding?: 'utf8' | 'base64'; ifHash?: string }
  | { op: 'delete'; path: string; ifHash?: string }
  | { op: 'move'; path: string; to: string; ifHash?: string }
  | { op: 'patch'; patch: string }

export interface EditedFile {
  path: string
  change: 'added' | 'modified' | 'deleted'
  sha256?: string
  size?: number
}

export interface EditPlan {
  files: EditedFile[]
  // what the files take after the edits, minus what they took before
  bytes: number
  commit(): Promise<void>
}

/**
 * The files of one sandbox, as the API sees them: relative paths, no symbolic link
 * followed, nothing of `.git/` or the deny list of uploads. Reads work at any time, edits
 * are planned in memory and then written, so a batch applies fully or not at all; that no
 * run holds the sandbox meanwhile is for the caller to make sure.
 */
export interface SandboxFiles {
  stat(path: string): Promise<FileStat | undefined>
  tree(query: TreeQuery): Promise<TreeResult>
  read(path: string, query: ReadQuery): Promise<ReadResult>
  raw(path: string): Promise<RawFile>
  search(query: SearchQuery): Promise<SearchResult>
  changes(): Promise<ChangedFile[]>
  diff(format: 'diff' | 'patch', author: PatchAuthor): Promise<string>
  plan(ops: EditOp[]): Promise<EditPlan>
}

// How the files of a sandbox reach its git data.
export interface SandboxGit {
  // git with the sandbox's git directory and files
  run(
    args: string[],
    action: string,
    options?: { env?: { [key: string]: string }; maxBuffer?: number }
  ): Promise<string>
  // `fn` with an index of its own, so reading the state of the files changes no index
  withIndex<T>(fn: (run: SandboxGit['run']) => Promise<T>): Promise<T>
}

/**
 * A path as the API takes it: relative, `/` between names, no `.` or `..`, and nothing the
 * deny list of uploads names (`.git/`, `.env`, keys).
 */
export function checkPath(path: string): string {
  if (
    path.length === 0 ||
    path.length > 4096 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    /^[A-Za-z]:/.test(path) ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new SandboxFileError(
      400,
      `${JSON.stringify(path.slice(0, 200))} is not a path in the sandbox: relative, / between names, no . or ..`
    )
  }
  const denied = deniedPath(path)
  if (denied) {
    throw new SandboxFileError(403, `${path}: ${denied}, the API does not read or write it`)
  }
  return path
}

// The deny list of uploads, with the last name taken as a directory too, so `.git` itself
// is as denied as what is in it.
export function deniedPath(path: string): string | null {
  return deniedSourcePath(path) ?? deniedSourcePath(`${path}/-`)
}

const DENIED_DIRECTORIES = ['.git', '.ssh', '.aws', '.gnupg', '.kube']

// What hammerkit itself writes next to a task while it runs: `.hammerkit/` in the task's
// directory, at any depth (the last resolved cache entry, the state of local tasks). It is
// the run's, not a change to the sandbox's files, so changes and pushes leave it out.
export const RUN_STATE_DIRECTORY = '.hammerkit'

export function isRunState(path: string): boolean {
  return path.split('/').slice(0, -1).includes(RUN_STATE_DIRECTORY)
}

function encodeCursor(value: string | number): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function decodeCursor<T extends string | number>(cursor: string | undefined, type: 'string' | 'number'): T | undefined {
  if (cursor === undefined || cursor === '') {
    return undefined
  }
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (typeof value === type) {
      return value as T
    }
  } catch {
    // answered below
  }
  throw new SandboxFileError(400, 'the cursor is not one this API gave out')
}

function clamp(value: number | undefined, fallback: number, max: number): number {
  return Math.min(Math.max(1, Math.floor(value ?? fallback)), max)
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function isNotFound(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

// The text of a file, or why it has none.
function decodeText(path: string, content: Buffer): string {
  if (content.subarray(0, 8000).includes(0)) {
    throw new SandboxFileError(415, `${path} is a binary file, read it raw (?raw) or write it with PUT`)
  }
  try {
    return utf8.decode(content)
  } catch {
    throw new SandboxFileError(415, `${path} is not UTF-8 text, read it raw (?raw) or write it with PUT`)
  }
}

// Files larger than this are read one by one, across sandboxes: a read holds a few times
// the size of its file at once.
const LARGE_FILE_BYTES = 1024 * 1024
const LARGE_READS = 4
let largeReads = 0
const waitingReads: (() => void)[] = []

async function readLimited<T>(size: number, fn: () => Promise<T>): Promise<T> {
  if (size <= LARGE_FILE_BYTES) {
    return fn()
  }
  if (largeReads < LARGE_READS) {
    largeReads++
  } else {
    // the read that finishes hands its place over
    await new Promise<void>((resolve) => waitingReads.push(resolve))
  }
  try {
    return await fn()
  } finally {
    const next = waitingReads.shift()
    if (next) {
      next()
    } else {
      largeReads--
    }
  }
}

// The bytes of an open file, as many as it had when it was opened: a task of a run may
// still be writing to it.
async function readOpened(handle: FileHandle, size: number): Promise<Buffer> {
  const content = Buffer.alloc(size)
  let read = 0
  while (read < size) {
    const { bytesRead } = await handle.read(content, read, size - read, read)
    if (bytesRead === 0) {
      break
    }
    read += bytesRead
  }
  return content.subarray(0, read)
}

function numbered(line: number, text: string): string {
  const shown = text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}… [${text.length} chars]` : text
  return `${String(line).padStart(6)}\t${shown}`
}

function fileType(stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileType {
  return stats.isSymbolicLink() ? 'symlink' : stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other'
}

/**
 * The files of a sandbox in a directory of this machine. Every path is checked name by
 * name with `lstat`, so a symbolic link a task made is never followed; a file is opened
 * without following a link, and on Linux the opened file is checked to be the one in the
 * sandbox, in case a task swapped a directory for a link in between.
 */
export class HostSandboxFiles implements SandboxFiles {
  private realRoot: Promise<string> | undefined

  constructor(
    private readonly root: string,
    private readonly git: SandboxGit,
    // the environment of ripgrep: the variables runs see
    private readonly env: { [key: string]: string | undefined },
    // the most a diff or patch of the changes may take
    private readonly maxChangesBytes = MAX_CHANGES_BYTES
  ) {}

  private absolute(path: string): string {
    return join(this.root, ...path.split('/'))
  }

  // Whether the directories above `path` are there; a link or a file among them is an error.
  private async parents(path: string): Promise<boolean> {
    const parts = path.split('/')
    let current = this.root
    for (let i = 0; i < parts.length - 1; i++) {
      current = join(current, parts[i])
      const stats = await lstat(current).catch((e) => {
        if (isNotFound(e)) {
          return undefined
        }
        throw e
      })
      if (!stats) {
        return false
      }
      const prefix = parts.slice(0, i + 1).join('/')
      if (stats.isSymbolicLink()) {
        throw new SandboxFileError(400, `${prefix} is a symbolic link, the API does not follow links`)
      }
      if (!stats.isDirectory()) {
        throw new SandboxFileError(400, `${prefix} is a file, not a directory`)
      }
    }
    return true
  }

  async stat(path: string): Promise<FileStat | undefined> {
    checkPath(path)
    if (!(await this.parents(path))) {
      return undefined
    }
    const absolute = this.absolute(path)
    const stats = await lstat(absolute).catch((e) => {
      if (isNotFound(e)) {
        return undefined
      }
      throw e
    })
    if (!stats) {
      return undefined
    }
    const type = fileType(stats)
    return {
      path,
      type,
      size: type === 'file' || type === 'symlink' ? stats.size : 0,
      exec: type === 'file' && (stats.mode & 0o111) !== 0,
      modifiedAt: stats.mtime.toISOString(),
      ...(type === 'symlink' ? { target: await readlink(absolute) } : {}),
    }
  }

  // Opens a file of the sandbox for reading, never through a link.
  private async open(path: string): Promise<{ handle: FileHandle; stat: FileStat }> {
    const found = await this.stat(path)
    if (!found) {
      throw new SandboxFileError(404, `${path} does not exist`)
    }
    if (found.type === 'symlink') {
      throw new SandboxFileError(400, `${path} is a symbolic link to ${found.target}, the API does not follow links`)
    }
    if (found.type === 'directory') {
      throw new SandboxFileError(400, `${path} is a directory, list it with tree`)
    }
    if (found.type === 'other') {
      throw new SandboxFileError(400, `${path} is a pipe, a socket or a device, not a file`)
    }
    const absolute = this.absolute(path)
    // without O_NONBLOCK, opening a pipe a task swapped in after the check waits for a writer
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    const handle = await open(absolute, flags).catch((e) => {
      if (isNotFound(e)) {
        throw new SandboxFileError(404, `${path} does not exist`)
      }
      if ((e as NodeJS.ErrnoException).code === 'ELOOP') {
        throw new SandboxFileError(400, `${path} is a symbolic link, the API does not follow links`)
      }
      throw e
    })
    try {
      const stats = await handle.stat()
      if (!stats.isFile()) {
        throw new SandboxFileError(400, `${path} is not a file`)
      }
      await this.mustBeInside(handle, absolute, path)
      return { handle, stat: { ...found, size: stats.size } }
    } catch (e) {
      await handle.close()
      throw e
    }
  }

  // The opened file is the one in the sandbox: a task may have swapped a directory above it
  // for a link after the names were checked. Linux names the file a descriptor is open on;
  // elsewhere the path has to lead to the same file and to no link.
  private async mustBeInside(handle: FileHandle, absolute: string, path: string): Promise<void> {
    let actual: string | undefined
    if (process.platform === 'linux') {
      actual = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => undefined)
    }
    if (actual === undefined) {
      const [opened, named] = await Promise.all([handle.stat(), lstat(absolute)])
      if (opened.ino !== named.ino || opened.dev !== named.dev) {
        throw new SandboxFileError(400, `${path} changed while it was opened, read it again`)
      }
      actual = await realpath(absolute)
    }
    this.realRoot ??= realpath(this.root)
    const expected = join(await this.realRoot, ...path.split('/'))
    const same =
      process.platform === 'win32' || process.platform === 'darwin'
        ? normalize(actual).toLowerCase() === normalize(expected).toLowerCase()
        : normalize(actual) === normalize(expected)
    if (!same) {
      throw new SandboxFileError(400, `${path} is reached through a symbolic link, the API does not follow links`)
    }
  }

  async read(path: string, query: ReadQuery): Promise<ReadResult> {
    const { handle, stat } = await this.open(path)
    if (stat.size > MAX_FILE_BYTES) {
      await handle.close()
      throw new SandboxFileError(413, `${path} takes ${stat.size} bytes, more than a read answers: read it raw`)
    }
    return readLimited(stat.size, async () => {
      let content: Buffer
      try {
        content = await readOpened(handle, stat.size)
      } finally {
        await handle.close()
      }
      return this.lines(path, content, query)
    })
  }

  private lines(path: string, content: Buffer, query: ReadQuery): ReadResult {
    const text = decodeText(path, content)
    const offset = Math.max(1, Math.floor(query.offset ?? 1))
    const limit = clamp(query.limit, READ_LINES, MAX_READ_LINES)
    const shown: string[] = []
    let bytes = 0
    let next = offset
    let full = false
    // line by line: splitting a file of empty lines at once takes many times its size
    let lines = 0
    for (let start = 0; start < text.length; ) {
      const end = text.indexOf('\n', start)
      const stop = end < 0 ? text.length : end
      lines++
      if (!full && lines === next && next < offset + limit) {
        const line = numbered(next, text.slice(start, stop))
        if (shown.length > 0 && bytes + line.length > MAX_READ_BYTES) {
          full = true
        } else {
          shown.push(line)
          bytes += line.length + 1
          next++
        }
      }
      start = stop + 1
    }
    const truncated = next <= lines
    return {
      path,
      sha256: sha256(content),
      size: content.length,
      lines,
      offset,
      content: shown.join('\n'),
      truncated,
      nextOffset: truncated ? next : null,
    }
  }

  async raw(path: string): Promise<RawFile> {
    const { handle, stat } = await this.open(path)
    if (stat.size > MAX_FILE_BYTES) {
      return { stat, stream: handle.createReadStream({ start: 0, end: Math.max(0, stat.size - 1) }) }
    }
    return readLimited(stat.size, async () => {
      try {
        const content = await readOpened(handle, stat.size)
        return { stat: { ...stat, size: content.length }, content, sha256: sha256(content) }
      } finally {
        await handle.close()
      }
    })
  }

  // The files git sees in the sandbox below `path`: committed or not, without what
  // `.gitignore` leaves out, without the deny list.
  private async listFiles(path: string | undefined): Promise<string[]> {
    const spec = path ? ['--', `:(literal)${path}`] : []
    const list = async (args: string[]) =>
      (await this.git.run(['ls-files', '-z', ...args, ...spec], 'list the files of', { maxBuffer: 256 * 1024 * 1024 }))
        .split('\0')
        .filter((file) => file.length > 0)
    const deleted = new Set(await list(['--deleted']))
    const files = await list(['--cached', '--others', '--exclude-standard'])
    return [...new Set(files)].filter((file) => !deleted.has(file) && !deniedPath(file.replace(/\/$/, '')))
  }

  async tree(query: TreeQuery): Promise<TreeResult> {
    const path = query.path ? checkPath(query.path) : undefined
    if (path) {
      const found = await this.stat(path)
      if (!found) {
        throw new SandboxFileError(404, `${path} does not exist`)
      }
      if (found.type !== 'directory') {
        const what = { file: 'file, read it', symlink: 'symbolic link', other: 'pipe, a socket or a device' }
        throw new SandboxFileError(400, `${path} is a ${what[found.type]}`)
      }
    }
    const depth = clamp(query.depth, 1, 64)
    const limit = clamp(query.limit, TREE_LIMIT, MAX_TREE_LIMIT)
    const after = decodeCursor<string>(query.cursor, 'string')
    const glob = query.glob ? new Minimatch(query.glob, { dot: true }) : undefined
    const prefix = path ? `${path}/` : ''
    const entries = new Map<string, FileType>()
    for (const listed of await this.listFiles(path)) {
      // an untracked repository inside the sandbox is listed as `dir/`
      const directory = listed.endsWith('/')
      const file = directory ? listed.slice(0, -1) : listed
      const relative = file.slice(prefix.length)
      if (glob) {
        if (!directory && glob.match(relative)) {
          entries.set(file, 'file')
        }
        continue
      }
      const parts = relative.split('/')
      for (let level = 1; level <= Math.min(depth, parts.length); level++) {
        const entry = prefix + parts.slice(0, level).join('/')
        entries.set(entry, level < parts.length || directory ? 'directory' : 'file')
      }
    }
    const all = [...entries.keys()].sort().filter((entry) => after === undefined || entry > after)
    const page = all.slice(0, limit)
    const result: TreeEntry[] = []
    for (const entry of page) {
      const type = entries.get(entry) as FileType
      if (type === 'directory') {
        result.push({ path: entry, type })
        continue
      }
      const stats = await lstat(this.absolute(entry)).catch(() => undefined)
      const found = stats ? fileType(stats) : 'file'
      result.push(
        found === 'symlink'
          ? { path: entry, type: found, target: await readlink(this.absolute(entry)).catch(() => '') }
          : found === 'other'
            ? { path: entry, type: found }
            : { path: entry, type: 'file', size: stats?.size ?? 0 }
      )
    }
    const truncated = all.length > page.length
    return {
      path: path ?? '',
      entries: result,
      total: entries.size,
      truncated,
      cursor: truncated ? encodeCursor(page[page.length - 1]) : null,
    }
  }

  async search(query: SearchQuery): Promise<SearchResult> {
    const mode = query.output_mode ?? 'files_with_matches'
    const limit = clamp(query.head_limit, SEARCH_LIMIT, MAX_SEARCH_LIMIT)
    const skip = decodeCursor<number>(query.cursor, 'number') ?? 0
    const path = query.path ? checkPath(query.path) : undefined
    if (path) {
      const found = await this.stat(path)
      if (!found) {
        throw new SandboxFileError(404, `${path} does not exist`)
      }
      if (found.type === 'symlink') {
        throw new SandboxFileError(400, `${path} is a symbolic link, the API does not follow links`)
      }
      if (found.type === 'other') {
        throw new SandboxFileError(400, `${path} is a pipe, a socket or a device, not a file`)
      }
    }
    if (query.type !== undefined && !/^[A-Za-z0-9_+-]{1,40}$/.test(query.type)) {
      throw new SandboxFileError(400, `${JSON.stringify(query.type.slice(0, 40))} is not a file type of ripgrep`)
    }
    const args = [
      '--no-config',
      // `.gitignore` counts although the git data is not in the files
      '--no-require-git',
      '--hidden',
      '--sort=path',
      '--path-separator=/',
      `--max-filesize=${MAX_FILE_BYTES}`,
      '--color=never',
      '--no-messages',
    ]
    if (query.i) {
      args.push('--ignore-case')
    }
    if (query.fixed_strings) {
      args.push('--fixed-strings')
    }
    if (query.multiline) {
      args.push('--multiline', '--multiline-dotall')
    }
    for (const glob of query.glob ?? []) {
      args.push(`--glob=${glob}`)
    }
    // after the caller's globs, which would otherwise take precedence
    // in any case, as a case-insensitive disk opens `.SSH` as `.ssh`; the paths found are
    // checked against the deny list as well
    for (const directory of DENIED_DIRECTORIES) {
      args.push(`--iglob=!${directory}`)
    }
    if (query.type) {
      args.push(`--type=${query.type}`)
    }
    if (mode === 'content') {
      args.push('--json')
      for (const flag of ['A', 'B', 'C'] as const) {
        const value = query[flag]
        if (value !== undefined) {
          args.push(`-${flag}`, String(Math.min(Math.max(0, Math.floor(value)), 100)))
        }
      }
    } else if (mode === 'files_with_matches') {
      args.push('--files-with-matches', '--null')
    } else {
      args.push('--count-matches', '--null')
    }
    args.push('--regexp', query.pattern, '--', path ?? '.')

    const result: SearchResult = { output_mode: mode, total: 0, exact: true, truncated: false, cursor: null }
    const files: string[] = []
    const matches: SearchLine[] = []
    const counts: { path: string; count: number }[] = []
    let total = 0
    const found = (add: () => void): boolean => {
      total++
      if (total > skip && total <= skip + limit) {
        add()
      }
      return total < skip + limit + SEARCH_COUNT
    }
    // the JSON of ripgrep names paths with the separator of the system, whatever --path-separator says
    const clean = (file: string) => {
      const path = process.platform === 'win32' ? file.replace(/\\/g, '/') : file
      return path.startsWith('./') ? path.slice(2) : path
    }
    const onRecord = (record: string): boolean => {
      if (mode === 'files_with_matches') {
        const file = clean(record)
        return deniedPath(file) ? true : found(() => files.push(file))
      }
      if (mode === 'count') {
        const [file, count] = record.split('\0')
        return deniedPath(clean(file)) ? true : found(() => counts.push({ path: clean(file), count: Number(count) }))
      }
      const message = JSON.parse(record) as {
        type: string
        data: { path?: { text?: string }; lines?: { text?: string }; line_number?: number }
      }
      if (message.type !== 'match' && message.type !== 'context') {
        return true
      }
      const file = clean(message.data.path?.text ?? '')
      if (!file || deniedPath(file)) {
        return true
      }
      const lines = (message.data.lines?.text ?? '').replace(/\n$/, '').split('\n')
      return lines.every((text, index) =>
        found(() =>
          matches.push({
            path: file,
            line: (message.data.line_number ?? 0) + index,
            text: text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}… [${text.length} chars]` : text,
            ...(message.type === 'context' ? { context: true as const } : {}),
          })
        )
      )
    }
    const { code, stderr, stopped } = await this.ripgrep(args, mode === 'files_with_matches' ? '\0' : '\n', onRecord)
    if (code === 2 && total === 0 && !stopped) {
      throw new SandboxFileError(400, stderr.trim() || 'ripgrep failed')
    }
    result.total = total
    result.exact = !stopped
    result.truncated = total > skip + limit
    result.cursor = result.truncated ? encodeCursor(skip + limit) : null
    if (mode === 'files_with_matches') {
      result.files = files
    } else if (mode === 'count') {
      result.counts = counts
    } else {
      result.matches = matches
    }
    return result
  }

  // Runs ripgrep in the files and hands each record of its output to `onRecord`, which
  // answers whether to read on.
  private ripgrep(
    args: string[],
    separator: string,
    onRecord: (record: string) => boolean
  ): Promise<{ code: number | null; stderr: string; stopped: boolean }> {
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(this.env)) {
      if (value !== undefined && !key.toUpperCase().startsWith('RIPGREP_')) {
        env[key] = value
      }
    }
    return new Promise((resolve, reject) => {
      const child = spawn('rg', args, {
        cwd: this.root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      })
      let stopped = false
      let buffered = ''
      let stderr = ''
      const take = (chunk: string) => {
        buffered += chunk
        let at: number
        while (!stopped && (at = buffered.indexOf(separator)) >= 0) {
          const record = buffered.slice(0, at)
          buffered = buffered.slice(at + 1)
          if (record.length > 0 && !onRecord(record)) {
            stopped = true
            child.kill()
          }
        }
      }
      child.stdout.setEncoding('utf8').on('data', take)
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-4000)
      })
      child.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') {
          reject(new SandboxFileError(501, 'ripgrep (rg) is not installed on the server, search needs it'))
        } else if (e.name === 'AbortError') {
          reject(new SandboxFileError(504, `the search took longer than ${SEARCH_TIMEOUT_MS / 1000}s, narrow it`))
        } else {
          reject(e)
        }
      })
      child.on('close', (code) => {
        if (!stopped && buffered.length > 0) {
          onRecord(buffered)
        }
        resolve({ code, stderr, stopped })
      })
    })
  }

  // The index of `fn` holds the files as they are, without what `.gitignore` leaves out and
  // without the deny list, so nothing on it leaves the sandbox through a diff. A repository a
  // task made inside the files is left out too: git adds it as a link to a commit of it,
  // whose id is not the sandbox's to tell. So is hammerkit's own run state (`isRunState`).
  private async withFilesIndex<T>(fn: (run: SandboxGit['run']) => Promise<T>): Promise<T> {
    return this.git.withIndex(async (run) => {
      await run(['add', '--all', '--', '.'], 'read')
      // `:<old mode> <new mode> <old id> <new id> <status>\0<path>\0`
      const raw = (await run(['diff', '--cached', '--raw', '-z', '--no-renames', 'HEAD'], 'read')).split('\0')
      const changed: string[] = []
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const file = raw[i + 1]
        if (deniedPath(file) || isRunState(file) || raw[i].split(' ')[1] === '160000') {
          changed.push(file)
        }
      }
      if (changed.length > 0) {
        await run(['reset', '--quiet', 'HEAD', '--', ...changed.map((file) => `:(literal)${file}`)], 'read')
      }
      return fn(run)
    })
  }

  async changes(): Promise<ChangedFile[]> {
    return this.withFilesIndex(async (run) => {
      const statuses = (await run(['diff', '--cached', '-M', '--name-status', '-z', 'HEAD'], 'read')).split('\0')
      const numbers = (await run(['diff', '--cached', '-M', '--numstat', '-z', 'HEAD'], 'read')).split('\0')
      const files: ChangedFile[] = []
      for (let i = 0; i < statuses.length - 1; ) {
        const status = statuses[i++]
        const letter = status[0]
        const from = letter === 'R' || letter === 'C' ? statuses[i++] : undefined
        const path = statuses[i++]
        files.push({
          path,
          status: ({ A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type' } as const)[letter] ?? 'modified',
          ...(from !== undefined ? { from } : {}),
          additions: null,
          deletions: null,
        })
      }
      // `added\tdeleted\tpath\0`, or for a rename `added\tdeleted\t\0from\0to\0`
      const byPath = new Map(files.map((file) => [file.path, file]))
      for (let i = 0; i < numbers.length - 1; ) {
        const [added, deleted, path] = numbers[i++].split('\t')
        const to = path === '' ? (i++, numbers[i++]) : path
        const file = byPath.get(to)
        if (file && added !== '-') {
          file.additions = Number(added)
          file.deletions = Number(deleted)
        }
      }
      return files
    })
  }

  async diff(format: 'diff' | 'patch', author: PatchAuthor): Promise<string> {
    return this.withFilesIndex(async (run) => {
      if (format === 'diff') {
        return run(['diff', '--cached', '-M', 'HEAD'], 'read', { maxBuffer: this.maxChangesBytes })
      }
      // a commit of the changes on top of the commit the sandbox is at, which no branch
      // points to, written out as `git format-patch` writes it
      const tree = (await run(['write-tree'], 'read')).trim()
      const identity = {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
      }
      const commit = (
        await run(['commit-tree', tree, '-p', 'HEAD', '-m', author.message], 'read', { env: identity })
      ).trim()
      return run(['format-patch', '-1', '--stdout', '--binary', '-M', commit], 'read', {
        maxBuffer: this.maxChangesBytes,
      })
    })
  }

  async plan(ops: EditOp[]): Promise<EditPlan> {
    const batch = new EditBatch(this)
    for (const [index, op] of ops.entries()) {
      try {
        await batch.apply(op)
      } catch (e) {
        if (e instanceof SandboxFileError) {
          throw new SandboxFileError(e.status, `op ${index} (${op.op}): ${e.message}`, { ...e.details, op: index })
        }
        if (e instanceof PatchError) {
          throw new SandboxFileError(422, `op ${index} (patch): ${e.message}`, { op: index })
        }
        throw e
      }
    }
    return batch.plan()
  }

  // What a path holds now, for an edit: its kind, and a file's content when it is read.
  async load(path: string): Promise<State> {
    if (!(await this.parents(path))) {
      return { kind: 'absent' }
    }
    const absolute = this.absolute(path)
    const stats = await lstat(absolute).catch((e) => {
      if (isNotFound(e)) {
        return undefined
      }
      throw e
    })
    if (!stats) {
      return { kind: 'absent' }
    }
    if (stats.isSymbolicLink()) {
      return { kind: 'link' }
    }
    if (stats.isDirectory()) {
      return { kind: 'directory' }
    }
    return { kind: 'file', size: stats.size, exec: (stats.mode & 0o111) !== 0, mode: stats.mode & 0o7777 }
  }

  async content(path: string, state: FileState): Promise<Buffer> {
    if (!state.content) {
      if (state.size > MAX_FILE_BYTES) {
        throw new SandboxFileError(413, `${path} takes ${state.size} bytes, more than an edit reads`)
      }
      const { handle, stat } = await this.open(path)
      try {
        // the size checked above is the one when the edit started
        if (stat.size > MAX_FILE_BYTES) {
          throw new SandboxFileError(413, `${path} takes ${stat.size} bytes, more than an edit reads`)
        }
        state.content = await readLimited(stat.size, () => readOpened(handle, stat.size))
      } finally {
        await handle.close()
      }
    }
    return state.content
  }

  // Writes the changes: what a path held is moved aside first, and put back when a later
  // write fails.
  async write(changes: [string, State, State][]): Promise<void> {
    const backups: [string, string][] = []
    const written: string[] = []
    // the directories above every path are still the ones the edits were planned in
    for (const [path] of changes) {
      await this.sameParents(path)
    }
    try {
      for (const [path, before] of changes) {
        if (before.kind === 'file' || before.kind === 'link') {
          const absolute = this.absolute(path)
          const backup = join(dirname(absolute), `.hammerkit-${randomBytes(6).toString('hex')}.bak`)
          await rename(absolute, backup)
          backups.push([absolute, backup])
        }
      }
      for (const [path, before, after] of [...changes].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (after.kind !== 'file') {
          continue
        }
        await this.makeParents(path)
        const absolute = this.absolute(path)
        const temporary = join(dirname(absolute), `.hammerkit-${randomBytes(6).toString('hex')}.tmp`)
        const base = before.kind === 'file' ? before.mode ?? 0o644 : 0o644
        const mode = after.exec ? base | ((base & 0o444) >> 2) | 0o100 : base & ~0o111
        await writeFile(temporary, after.content ?? Buffer.alloc(0), { flag: 'wx', mode })
        await chmod(temporary, mode)
        await rename(temporary, absolute)
        written.push(absolute)
      }
    } catch (e) {
      for (const absolute of written.reverse()) {
        await rm(absolute, { force: true })
      }
      for (const [absolute, backup] of backups.reverse()) {
        await rename(backup, absolute).catch(() => undefined)
      }
      throw e
    }
    for (const [, backup] of backups) {
      await rm(backup, { force: true })
    }
  }

  private async sameParents(path: string): Promise<void> {
    const parts = path.split('/')
    let current = this.root
    for (let i = 0; i < parts.length - 1; i++) {
      current = join(current, parts[i])
      const stats = await lstat(current).catch(() => undefined)
      if (!stats) {
        return
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new SandboxFileError(409, `${parts.slice(0, i + 1).join('/')} is not a directory any more`)
      }
    }
  }

  private async makeParents(path: string): Promise<void> {
    const parts = path.split('/')
    let current = this.root
    for (let i = 0; i < parts.length - 1; i++) {
      current = join(current, parts[i])
      const stats = await lstat(current).catch(() => undefined)
      if (!stats) {
        await mkdir(current)
      } else if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new SandboxFileError(409, `${parts.slice(0, i + 1).join('/')} is not a directory any more`)
      }
    }
  }
}

interface FileState {
  kind: 'file'
  size: number
  exec: boolean
  // the permission bits on disk, kept when the file is changed
  mode?: number
  content?: Buffer
}

type State = { kind: 'absent' } | { kind: 'directory' } | { kind: 'link' } | FileState

// The edits of one request, applied to what the files would hold after them, before any
// of it is written.
class EditBatch {
  private readonly before = new Map<string, State>()
  private readonly after = new Map<string, State>()

  constructor(private readonly files: HostSandboxFiles) {}

  private async current(path: string): Promise<State> {
    const changed = this.after.get(path)
    if (changed) {
      return changed
    }
    let original = this.before.get(path)
    if (!original) {
      original = await this.files.load(path)
      this.before.set(path, original)
    }
    return original
  }

  private async text(path: string, state: FileState): Promise<string> {
    return decodeText(path, await this.files.content(path, state))
  }

  private async file(path: string, verb: string): Promise<FileState> {
    const state = await this.current(path)
    if (state.kind === 'absent') {
      throw new SandboxFileError(404, `${path} does not exist${verb === 'replace in' ? ', create it with write' : ''}`)
    }
    if (state.kind === 'link') {
      throw new SandboxFileError(400, `${path} is a symbolic link, the API does not ${verb} links`)
    }
    if (state.kind === 'directory') {
      throw new SandboxFileError(400, `${path} is a directory, ${verb} its files one by one`)
    }
    return state
  }

  private async checkHash(path: string, ifHash: string | undefined): Promise<void> {
    if (ifHash === undefined) {
      return
    }
    const state = await this.current(path)
    const actual = state.kind === 'file' ? sha256(await this.files.content(path, state)) : undefined
    if (actual !== ifHash.toLowerCase()) {
      throw new SandboxFileError(
        412,
        actual
          ? `${path} changed since you read it (sha256 ${actual}), read it again`
          : `${path} does not exist any more, read it again`
      )
    }
  }

  // A path a file may be written to: nothing but directories above it, no directory there.
  private async writable(path: string): Promise<State> {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const above = parts.slice(0, i).join('/')
      const state = await this.current(above)
      if (state.kind === 'file' || state.kind === 'link') {
        throw new SandboxFileError(
          400,
          `${above} is a ${state.kind === 'file' ? 'file' : 'symbolic link'}, not a directory`
        )
      }
    }
    for (const [other, state] of this.after) {
      if (other.startsWith(`${path}/`) && state.kind === 'file') {
        throw new SandboxFileError(400, `${path} is a directory of ${other}, written before in this batch`)
      }
    }
    const state = await this.current(path)
    if (state.kind === 'directory') {
      throw new SandboxFileError(400, `${path} is a directory`)
    }
    return state
  }

  private set(path: string, content: Buffer, exec: boolean): void {
    if (content.length > MAX_FILE_BYTES) {
      throw new SandboxFileError(413, `${path} would take ${content.length} bytes, more than ${MAX_FILE_BYTES}`)
    }
    this.after.set(path, { kind: 'file', size: content.length, exec, content })
  }

  async apply(op: EditOp): Promise<void> {
    if (op.op === 'patch') {
      return this.patch(op.patch)
    }
    const path = checkPath(op.path)
    await this.checkHash(path, op.ifHash)
    if (op.op === 'replace') {
      const state = await this.file(path, 'replace in')
      const text = await this.text(path, state)
      if (op.old_string === '') {
        throw new SandboxFileError(422, 'old_string is empty, write the file to create it')
      }
      if (op.old_string === op.new_string) {
        throw new SandboxFileError(422, 'old_string and new_string are the same, nothing would change')
      }
      const at: number[] = []
      for (
        let found = text.indexOf(op.old_string);
        found >= 0;
        found = text.indexOf(op.old_string, found + op.old_string.length)
      ) {
        at.push(found)
      }
      if (at.length === 0) {
        throw new SandboxFileError(
          422,
          `old_string is not in ${path}; it has to match the file exactly, whitespace and indentation included: read the file again`
        )
      }
      if (at.length > 1 && !op.replace_all) {
        const lines = at.slice(0, 10).map((offset) => text.slice(0, offset).split('\n').length)
        throw new SandboxFileError(
          422,
          `old_string is ${at.length} times in ${path}, at lines ${lines.join(', ')}${
            at.length > 10 ? ', …' : ''
          }: add lines around it until it is there once, or set replace_all`,
          { lines }
        )
      }
      const replaced = op.replace_all
        ? text.split(op.old_string).join(op.new_string)
        : text.slice(0, at[0]) + op.new_string + text.slice(at[0] + op.old_string.length)
      this.set(path, Buffer.from(replaced, 'utf8'), state.exec)
    } else if (op.op === 'write') {
      const state = await this.writable(path)
      const content =
        typeof op.content === 'string'
          ? Buffer.from(op.content, op.encoding === 'base64' ? 'base64' : 'utf8')
          : op.content
      this.set(path, content, state.kind === 'file' ? state.exec : false)
    } else if (op.op === 'delete') {
      const state = await this.current(path)
      if (state.kind === 'absent') {
        throw new SandboxFileError(404, `${path} does not exist`)
      }
      if (state.kind === 'directory') {
        throw new SandboxFileError(400, `${path} is a directory, delete its files one by one`)
      }
      this.after.set(path, { kind: 'absent' })
    } else {
      const to = checkPath(op.to)
      const state = await this.file(path, 'move')
      const content = await this.files.content(path, state)
      const target = await this.writable(to)
      if (target.kind !== 'absent') {
        throw new SandboxFileError(409, `${to} exists, delete it first`)
      }
      this.after.set(path, { kind: 'absent' })
      this.set(to, content, state.exec)
    }
  }

  private async patch(text: string): Promise<void> {
    for (const file of parsePatch(text)) {
      await this.patchFile(file)
    }
  }

  private async patchFile(file: FilePatch): Promise<void> {
    const from = file.from !== undefined ? checkPath(file.from) : undefined
    const to = file.to !== undefined ? checkPath(file.to) : undefined
    let content = ''
    let exec = false
    if (from !== undefined) {
      const state = await this.file(from, 'patch')
      content = await this.text(from, state)
      exec = state.exec
    }
    if (to !== undefined && to !== from) {
      const target = await this.writable(to)
      if (target.kind !== 'absent') {
        throw new SandboxFileError(409, `${to} exists, the patch ${from ? 'moves a file onto' : 'adds'} it`)
      }
    }
    const result = file.apply(content)
    if (to === undefined) {
      if (from !== undefined && result !== '') {
        throw new PatchError(`${from}: the patch deletes it, but its lines are not what the file holds`)
      }
      this.after.set(from as string, { kind: 'absent' })
      return
    }
    if (from !== undefined && from !== to && !file.copy) {
      this.after.set(from, { kind: 'absent' })
    }
    this.set(to, Buffer.from(result, 'utf8'), file.exec ?? exec)
  }

  async plan(): Promise<EditPlan> {
    const changes: [string, State, State][] = []
    for (const [path, after] of this.after) {
      const before = this.before.get(path) ?? (await this.files.load(path))
      if (await this.same(path, before, after)) {
        continue
      }
      changes.push([path, before, after])
    }
    const size = (state: State) => (state.kind === 'file' ? state.size : 0)
    return {
      files: changes
        .map(([path, before, after]): EditedFile => {
          if (after.kind !== 'file') {
            return { path, change: 'deleted' }
          }
          const content = after.content ?? Buffer.alloc(0)
          return {
            path,
            change: before.kind === 'absent' ? 'added' : 'modified',
            sha256: sha256(content),
            size: content.length,
          }
        })
        .sort((a, b) => (a.path < b.path ? -1 : 1)),
      bytes: changes.reduce((sum, [, before, after]) => sum + size(after) - size(before), 0),
      commit: () => this.files.write(changes),
    }
  }

  private async same(path: string, before: State, after: State): Promise<boolean> {
    if (before.kind !== after.kind) {
      return false
    }
    if (before.kind !== 'file' || after.kind !== 'file') {
      return before.kind === 'absent'
    }
    return (
      before.exec === after.exec &&
      before.size === after.size &&
      (await this.files.content(path, before)).equals(after.content ?? Buffer.alloc(0))
    )
  }
}
