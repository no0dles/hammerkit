import { randomBytes } from 'crypto'
import { Stats } from 'fs'
import { chmod, copyFile, lstat, mkdir, readdir, readlink, rm, stat, utimes } from 'fs/promises'
import { join, relative, sep } from 'path'
import { git, isValidRef } from './git-checkout'
import { SandboxContainers } from './sandbox-docker'
import { HostSandboxFiles, PatchAuthor, SandboxFiles, SandboxGit } from './sandbox-files'

// how many directories the walk reads at once, and how many entries of one it looks at at once
const WALK_DIRECTORIES = 16
const WALK_ENTRIES = 256

// What a sandbox's files are at a moment: the commit it was fetched at, and the git tree
// of its files as they are (what `.gitignore` leaves out is not part of it). The two are
// the same tree when nothing was changed.
export interface SandboxState {
  commit: string
  tree: string
  clean: boolean
}

// How to read a repository: its address, and the environment of the git process that
// holds the read credential.
export interface SandboxFetch {
  url: string
  // a branch, without `refs/heads/`
  ref: string
  env: { [key: string]: string }
  signal: AbortSignal
}

// Which sandbox: its id, and its owner, whose namespace a cluster keeps it in.
export interface SandboxKey {
  id: string
  owner: { iss: string; sub: string }
}

// What a run works on. On a host it is the sandbox's own directory; on a cluster it is a
// copy of the files for the process of the run, which plans with it, while the tasks
// mount the claim itself, so what they write lands in the sandbox.
export interface SandboxAttachment {
  directory: string
  claim?: SandboxClaim
}

export interface SandboxClaim {
  name: string
  namespace: string
  // where the files are in the claim; a source of a task below `directory` is mounted
  // from below it
  subPath: string
  // the pods that mount the claim carry it as `hammerkit.dev/sandbox` and keep to one
  // node: a claim that can be written by one node at a time
  label: string
}

// Storage of a sandbox that a list found, with or without a record.
export interface StoredSandbox {
  id: string
  // none: storage this server keeps, but does not remove without a record (another
  // server's, or one of another configuration)
  remove?: () => Promise<void>
  // when it was made: storage without a record is only removed once it is old enough not
  // to be one that is being created
  createdAt?: Date
}

// How to push the changes of a sandbox: where to, the commit the branch has to be at now
// (none: the branch must not exist), and the environment of the git process that holds
// the write credential.
export interface SandboxPush {
  url: string
  branch: string
  expect: string | null
  author: PatchAuthor
  env: { [key: string]: string }
  signal: AbortSignal
}

export class SandboxPushConflict extends Error {}

// A push that failed after its commit was written: the remote may have taken it anyway (a
// timeout after it answered), which the caller checks against the branch.
export class SandboxPushFailed extends Error {
  constructor(
    readonly commit: string,
    readonly cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause))
  }
}

/**
 * Where the files of sandboxes are kept. The registry of sandboxes, the API and the
 * executor only know a sandbox and, while a run uses it, what to attach; how the files
 * are stored is this interface's. A host keeps a directory per sandbox
 * (HostSandboxStorage); a cluster keeps a claim per sandbox in its caller's namespace
 * (KubernetesSandboxStorage).
 */
export interface SandboxStorage {
  // whether one file can be read while a run holds the sandbox; walks and edits never can
  readonly readsWhileHeld: boolean
  // fetches the branch into new storage for the sandbox, and answers the commit
  create(key: SandboxKey, fetch: SandboxFetch): Promise<string>
  // moves the files to another commit; only for a sandbox without changes
  fetch(key: SandboxKey, fetch: SandboxFetch): Promise<string>
  state(key: SandboxKey, signal?: AbortSignal): Promise<SandboxState>
  // what a run works on; `into` is a directory of the run, for a copy of the files
  attach(key: SandboxKey, into: string): Promise<SandboxAttachment>
  // the bytes it takes, its git data included
  usage(key: SandboxKey): Promise<number>
  // reading, searching and editing its files through the API
  files(key: SandboxKey): SandboxFiles
  // commits the changes on top of the commit the sandbox is at and pushes that commit to
  // the branch; none when there is nothing to push. The sandbox stays where it is.
  push(key: SandboxKey, push: SandboxPush): Promise<string | undefined>
  // moves the sandbox to a commit it pushed, keeping its files: its changes are then what
  // is not pushed yet
  moveTo(key: SandboxKey, commit: string): Promise<void>
  remove(key: SandboxKey): Promise<void>
  // what has storage, to clean up what a crash left behind
  list(): Promise<StoredSandbox[]>
}

// the commit a sandbox pushed last, in its own git data
const PUSHED_REF = 'refs/hammerkit/pushed'

/**
 * Sandboxes as directories below `directory`, one per sandbox: `files` is the checkout the
 * tasks work on, `git` its git data. The git data is kept outside of the files on purpose:
 * tasks write to the files, and a `.git/config` or a hook they wrote would be read by the
 * git of the server, which runs as the server's user. Every git command names its git
 * directory and work tree, and runs without hooks or a file system monitor.
 */
export class HostSandboxStorage implements SandboxStorage {
  readonly readsWhileHeld = true
  // one git command or walk at a time per sandbox: the objects `state` writes are pruned
  // again, which must not meet another command that still needs them
  private readonly queues = new Map<string, Promise<unknown>>()
  // the sandboxes walked since a run last wrote to them, with the links the walk found: only
  // a run's tasks write to a sandbox, between its `attach` and the `usage` it ends with, so
  // until the next attach a `state` needs no walk. The edits of the file API write readable
  // files and never a link, so a walk still holds after them: a link it found that an edit
  // replaced is no link any more, and is added as the file it is.
  private readonly walked = new Map<string, string[]>()
  // the sandboxes a run attached and that were not measured since, and how often each was
  // attached: a walk while a run may write, or that a run attached during, is not reused
  private readonly attached = new Set<string>()
  private readonly attaches = new Map<string, number>()

  constructor(
    private readonly directory: string,
    // the environment of git when it reads a sandbox: the variables runs see
    private readonly env: { [key: string]: string | undefined },
    // what containers left of a sandbox, when runs on it use containers
    private readonly containers?: SandboxContainers
  ) {}

  private exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    const settled = next.catch(() => undefined)
    this.queues.set(id, settled)
    settled.then(() => {
      if (this.queues.get(id) === settled) {
        this.queues.delete(id)
      }
    })
    return next
  }

  private root(id: string): string {
    return join(this.directory, id)
  }

  private workTree(id: string): string {
    return join(this.root(id), 'files')
  }

  private async git(
    id: string,
    args: string[],
    env: { [key: string]: string },
    signal: AbortSignal,
    action: string,
    options: { input?: string | Buffer; exitCodes?: number[]; maxBuffer?: number } = {}
  ): Promise<string> {
    const root = this.root(id)
    return git(
      [
        `--git-dir=${join(root, 'git')}`,
        `--work-tree=${this.workTree(id)}`,
        '-c',
        `core.hooksPath=${join(root, 'no-hooks')}`,
        '-c',
        'core.fsmonitor=false',
        // files as committed, on every system: a checkout with the machine's line endings
        // and a read without its config would see every file changed (Git for Windows)
        '-c',
        'core.autocrlf=false',
        '-c',
        'advice.detachedHead=false',
        '-c',
        'advice.addEmbeddedRepo=false',
        ...args,
      ],
      env,
      signal,
      `sandbox ${id}`,
      action,
      options
    )
  }

  // The environment of git when it reads the sandbox, without an index of its own.
  private readEnv(extra: { [key: string]: string } = {}): { [key: string]: string } {
    const env: { [key: string]: string } = {}
    for (const [key, value] of Object.entries(this.env)) {
      if (value !== undefined && key !== 'GIT_INDEX_FILE') {
        env[key] = value
      }
    }
    // reading the files needs no configuration of the server's: a filter or attributes the
    // machine's git config names would run on files a task wrote
    env.GIT_CONFIG_NOSYSTEM = '1'
    // a file that is never there, which git reads as empty: Git for Windows refuses `\\.\nul`
    env.GIT_CONFIG_GLOBAL = join(this.directory, 'no-git-config')
    return { ...env, ...extra }
  }

  // `fn` with a copy of the sandbox's index that holds the files as they are (`addFiles`), so
  // neither the index nor the files change, and what it wrote to the git data is pruned again.
  // Files a task made unreadable are made readable first: git would leave them out and call
  // them unchanged. Holds the sandbox. No walk when nothing wrote since the last one.
  private withIndex<T>(id: string, signal: AbortSignal, fn: (run: SandboxGit['run']) => Promise<T>): Promise<T> {
    return this.exclusive(id, async () => {
      const links = this.walked.get(id) ?? (await this.walkOnce(id)).links
      try {
        return await this.indexed(id, signal, links, fn)
      } finally {
        await this.prune(id)
      }
    })
  }

  // a copy of the index that holds the files as they are (`addFiles`)
  private async indexed<T>(
    id: string,
    signal: AbortSignal,
    links: string[],
    fn: (run: SandboxGit['run']) => Promise<T>
  ): Promise<T> {
    const root = this.root(id)
    const index = join(root, `index-${randomBytes(6).toString('hex')}`)
    try {
      const original = join(root, 'git', 'index')
      await copyFile(original, index).then(
        // with the time of the index: git takes a file changed in the same second as it was
        // written for changed only when the index is no newer than the file (racy git)
        async () => {
          const stats = await stat(original)
          await utimes(index, stats.atime, stats.mtime)
        },
        () => undefined
      )
      const env = this.readEnv({ GIT_INDEX_FILE: index })
      await this.addFiles(id, env, signal, links)
      return await fn((args, action, options = {}) =>
        this.git(id, args, { ...env, ...options.env }, signal, action, { maxBuffer: options.maxBuffer })
      )
    } finally {
      await rm(index, { force: true })
    }
  }

  // the sandbox's own index, HEAD and refs keep what they need
  private async prune(id: string): Promise<void> {
    await this.git(id, ['prune', '--expire=now'], this.readEnv(), AbortSignal.timeout(60_000), 'read').catch(
      () => undefined
    )
  }

  // `maxChangesBytes` is for tests, which make changes larger than it without writing 64 MiB
  files({ id }: SandboxKey, maxChangesBytes?: number): SandboxFiles {
    return this.filesOf(id, (fn) => this.withIndex(id, AbortSignal.timeout(5 * 60 * 1000), fn), maxChangesBytes)
  }

  private filesOf(id: string, withIndex: SandboxGit['withIndex'], maxChangesBytes?: number): SandboxFiles {
    const timeout = () => AbortSignal.timeout(5 * 60 * 1000)
    return new HostSandboxFiles(
      this.workTree(id),
      {
        run: (args, action, options = {}) =>
          this.git(id, args, this.readEnv(options.env), timeout(), action, { maxBuffer: options.maxBuffer }),
        withIndex,
      },
      this.env,
      maxChangesBytes
    )
  }

  async create({ id }: SandboxKey, fetch: SandboxFetch): Promise<string> {
    const root = this.root(id)
    // the sandboxes are their owners', nobody else on the machine reads them
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await mkdir(this.workTree(id), { recursive: true })
    try {
      await git(['init', '--quiet', '--bare', join(root, 'git')], fetch.env, fetch.signal, `sandbox ${id}`, 'create')
      return await this.checkout(id, fetch, true)
    } catch (e) {
      await this.removeId(id)
      throw e
    }
  }

  async fetch({ id }: SandboxKey, fetch: SandboxFetch): Promise<string> {
    return this.exclusive(id, () => this.checkout(id, fetch, false))
  }

  private async checkout(id: string, fetch: SandboxFetch, force: boolean): Promise<string> {
    if (!isValidRef(fetch.ref)) {
      throw new Error(`${JSON.stringify(fetch.ref.slice(0, 80))} is not a branch`)
    }
    this.walked.delete(id)
    // the branch by its full name: a tag of the same name is never taken
    await this.git(
      id,
      ['fetch', '--quiet', '--depth', '1', '--', fetch.url, `refs/heads/${fetch.ref}`],
      fetch.env,
      fetch.signal,
      'fetch'
    )
    await this.git(
      id,
      ['checkout', '--quiet', ...(force ? ['--force'] : []), 'FETCH_HEAD'],
      fetch.env,
      fetch.signal,
      'check out'
    )
    return (await this.git(id, ['rev-parse', 'HEAD'], fetch.env, fetch.signal, 'read')).trim()
  }

  // One hold of the sandbox from the commit to the push: a prune in between would remove the
  // commit. A ref keeps the commit until the sandbox is moved to it, also when the push
  // failed late and the remote has it after all.
  async push({ id }: SandboxKey, push: SandboxPush): Promise<string | undefined> {
    return this.exclusive(id, async () => {
      const links = this.walked.get(id) ?? (await this.walkOnce(id)).links
      try {
        return await this.commitAndPush(id, push, links)
      } finally {
        await this.prune(id)
      }
    })
  }

  // Commits the changes for a push from elsewhere (the server, for the pod of a sandbox on a
  // cluster), and keeps the commit as the push does until the sandbox is moved to it.
  async commit({ id }: SandboxKey, author: PatchAuthor, signal: AbortSignal): Promise<string | undefined> {
    return this.exclusive(id, async () => {
      const links = this.walked.get(id) ?? (await this.walkOnce(id)).links
      try {
        return await this.keptCommit(id, author, signal, links)
      } finally {
        await this.prune(id)
      }
    })
  }

  private async keptCommit(
    id: string,
    author: PatchAuthor,
    signal: AbortSignal,
    links: string[]
  ): Promise<string | undefined> {
    const commit = await this.filesOf(id, (fn) => this.indexed(id, signal, links, fn)).commit(author)
    if (commit) {
      await this.git(id, ['update-ref', PUSHED_REF, commit], this.readEnv(), signal, 'push')
    }
    return commit
  }

  private async commitAndPush(id: string, push: SandboxPush, links: string[]): Promise<string | undefined> {
    const commit = await this.keptCommit(id, push.author, push.signal, links)
    if (!commit) {
      return undefined
    }
    const run = (args: string[], action: string, env = this.readEnv()) => this.git(id, args, env, push.signal, action)
    // a branch this sandbox pushed before only moves forward: the sandbox is at what it
    // pushed last, or it was moved since and its changes are on another commit
    if (push.expect) {
      const ancestor = await run(['merge-base', '--is-ancestor', push.expect, commit], 'read').then(
        () => true,
        () => false
      )
      if (!ancestor) {
        throw new SandboxPushConflict(
          `${push.branch} is at ${push.expect}, which the sandbox is no longer on: push to a new branch`
        )
      }
    }
    // the lease makes the remote refuse when the branch moved since it was read, and when
    // somebody created it meanwhile
    try {
      await run(
        [
          'push',
          '--quiet',
          '--no-verify',
          `--force-with-lease=refs/heads/${push.branch}:${push.expect ?? ''}`,
          '--',
          push.url,
          `${commit}:refs/heads/${push.branch}`,
        ],
        'push',
        // the write credential is in the environment of this one git process, which is
        // that environment alone: nothing of the server's own git configuration
        push.env
      )
    } catch (e) {
      throw new SandboxPushFailed(commit, e)
    }
    return commit
  }

  async moveTo({ id }: SandboxKey, commit: string): Promise<void> {
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit)) {
      throw new Error(`${JSON.stringify(commit.slice(0, 80))} is not a commit`)
    }
    await this.exclusive(id, () =>
      this.git(id, ['reset', '--quiet', commit], this.readEnv(), AbortSignal.timeout(5 * 60 * 1000), 'move')
    )
  }

  // The tree is written with an index of its own, so neither the sandbox's index nor its
  // files change, and what it wrote to the git data is pruned again. Files a task made
  // unreadable are made readable first: git would leave them out and call the sandbox
  // clean.
  async state({ id }: SandboxKey, signal: AbortSignal = AbortSignal.timeout(5 * 60 * 1000)): Promise<SandboxState> {
    return this.withIndex(id, signal, async (run) => {
      const tree = (await run(['write-tree'], 'read')).trim()
      const [commit, base] = (await run(['rev-parse', 'HEAD', 'HEAD^{tree}'], 'read')).trim().split('\n')
      return { commit, tree, clean: tree === base }
    })
  }

  // Adds the files as they are to the index of `env`. A link is written as a link and never
  // walked: Git for Windows takes a junction for a directory, and would read what a
  // `mklink /J x C:\` of a task points to.
  private async addFiles(
    id: string,
    env: { [key: string]: string },
    signal: AbortSignal,
    links: string[]
  ): Promise<void> {
    const written = await this.unignoredLinks(id, links, env, signal)
    const pathspecs = ['.', ...written.map((link) => `:(top,exclude,literal)${link.path}`)]
    await this.git(id, ['add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul'], env, signal, 'read', {
      input: pathspecs.map((pathspec) => `${pathspec}\0`).join(''),
    })
    if (written.length > 0) {
      const entries: string[] = []
      for (const link of written) {
        const blob = await this.git(id, ['hash-object', '-w', '--stdin'], env, signal, 'read', { input: link.target })
        entries.push(`120000 ${blob.trim()}\t${link.path}\0`)
      }
      await this.git(id, ['update-index', '-z', '--add', '--replace', '--index-info'], env, signal, 'read', {
        input: entries.join(''),
      })
    }
  }

  // the links of the files that are still links and that git does not ignore, by their path
  // in the files ('/'-separated) and their target
  private async unignoredLinks(
    id: string,
    paths: string[],
    env: { [key: string]: string },
    signal: AbortSignal
  ): Promise<{ path: string; target: Buffer }[]> {
    const files = this.workTree(id)
    const links: { path: string; target: Buffer }[] = []
    for (const path of paths) {
      if (!path.startsWith(files + sep) || !(await lstat(path).catch(() => undefined))?.isSymbolicLink()) {
        continue
      }
      links.push({ path: relative(files, path).split(sep).join('/'), target: await readlink(path, 'buffer') })
    }
    if (links.length === 0) {
      return []
    }
    const ignored = await this.git(id, ['check-ignore', '-z', '--stdin'], env, signal, 'read', {
      input: links.map((link) => `${link.path}\0`).join(''),
      exitCodes: [1],
    })
    const skip = new Set(ignored.split('\0'))
    return links.filter((link) => !skip.has(link.path))
  }

  // the run works in the sandbox itself
  async attach({ id }: SandboxKey): Promise<SandboxAttachment> {
    const files = this.workTree(id)
    const stats = await lstat(files).catch(() => undefined)
    if (!stats?.isDirectory()) {
      throw new Error(`the sandbox ${id} has no files on this server`)
    }
    // the run's tasks write from now on
    this.walked.delete(id)
    this.attached.add(id)
    this.attaches.set(id, (this.attaches.get(id) ?? 0) + 1)
    return { directory: files }
  }

  // What a task wrote is counted whatever it did to the modes, and with the volumes of its
  // outputs. Symbolic links are counted, not followed: a link a task made points anywhere.
  async usage({ id }: SandboxKey): Promise<number> {
    return this.exclusive(id, async () => {
      // after a run: its tasks are done
      this.attached.delete(id)
      const { bytes } = await this.walkOnce(id)
      return bytes + ((await this.containers?.volumeBytes(this.workTree(id)).catch(() => 0)) ?? 0)
    })
  }

  async remove({ id }: SandboxKey): Promise<void> {
    await this.removeId(id)
  }

  private async removeId(id: string): Promise<void> {
    await this.exclusive(id, async () => {
      this.walked.delete(id)
      this.attached.delete(id)
      this.attaches.delete(id)
      await this.reclaim(id).catch(() => undefined)
      await rm(this.root(id), { recursive: true, force: true, maxRetries: 3 })
      // without docker there is nothing to remove now; volumes stay labelled with the files
      await this.containers?.removeVolumes(this.workTree(id)).catch(() => undefined)
    })
  }

  // Walks the sandbox, and keeps the walk for the next `state` when no run wrote meanwhile.
  private async walkOnce(id: string): Promise<Walk> {
    const attaches = this.attaches.get(id)
    const walk = await this.reclaim(id)
    if (!this.attached.has(id) && this.attaches.get(id) === attaches) {
      this.walked.set(id, walk.links)
    }
    return walk
  }

  // Walks the sandbox, makes every directory and file the server's user can read and write
  // (a task runs as that user and may have taken its own permissions away) and answers the
  // bytes. What a container left as another user is given back through a container first.
  private async reclaim(id: string): Promise<Walk> {
    try {
      return await this.walk(this.root(id))
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (!this.containers || (code !== 'EPERM' && code !== 'EACCES')) {
        throw e
      }
      await this.containers.reclaim(this.root(id))
      return await this.walk(this.root(id))
    }
  }

  // Directories a few at a time and the entries of each together: a `node_modules` holds
  // tens of thousands of files, and one at a time took seconds for every run.
  private async walk(root: string): Promise<Walk> {
    let bytes = 0
    const links: string[] = []
    let pending = [root]
    while (pending.length > 0) {
      const directories = pending.slice(0, WALK_DIRECTORIES)
      pending = pending.slice(WALK_DIRECTORIES)
      for (const found of await Promise.all(directories.map((directory) => this.walkDirectory(directory, root)))) {
        bytes += found.bytes
        links.push(...found.links)
        pending.push(...found.directories)
      }
    }
    return { bytes, links }
  }

  private async walkDirectory(
    current: string,
    root: string
  ): Promise<{ bytes: number; directories: string[]; links: string[] }> {
    await ensureMode(current, 0o700)
    const entries = await readdir(current, { withFileTypes: true }).catch((e) => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' && current !== root) {
        return []
      }
      throw e
    })
    const directories: string[] = []
    const links: string[] = []
    let bytes = 0
    for (let start = 0; start < entries.length; start += WALK_ENTRIES) {
      const sizes = await Promise.all(
        entries.slice(start, start + WALK_ENTRIES).map(async (entry) => {
          const path = join(current, entry.name)
          if (entry.isDirectory()) {
            directories.push(path)
            return 0
          }
          if (entry.isSymbolicLink()) {
            links.push(path)
          }
          // one lstat for the mode and the size; a link is counted, not followed
          return (await ensureMode(path, entry.isFile() ? 0o600 : 0))?.size ?? 0
        })
      )
      bytes += sizes.reduce((sum, size) => sum + size, 0)
    }
    return { bytes, directories, links }
  }

  async list(): Promise<StoredSandbox[]> {
    // only a server that never kept a sandbox has no directory; any other error is one
    const entries = await readdir(this.directory, { withFileTypes: true }).catch((e) => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw e
    })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ id: entry.name, remove: () => this.removeId(entry.name) }))
  }
}

// the bytes of a sandbox and the paths of the links in it
interface Walk {
  bytes: number
  links: string[]
}

// adds the bits of the owner a path lacks and answers what it found; a path that is gone
// since it was listed is fine
async function ensureMode(path: string, bits: number): Promise<Stats | undefined> {
  const stats = await lstat(path).catch((e) => {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw e
  })
  if (stats && (stats.mode & bits) !== bits) {
    await chmod(path, (stats.mode & 0o7777) | bits)
  }
  return stats
}
