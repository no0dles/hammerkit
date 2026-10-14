import { randomBytes } from 'crypto'
import { Stats } from 'fs'
import { chmod, copyFile, lstat, mkdir, readdir, rm, stat, utimes } from 'fs/promises'
import { join } from 'path'
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
 * executor only know a sandbox id and, while a run uses it, a directory; how the files are
 * stored is this interface's. A host keeps a directory per sandbox; a cluster would keep a
 * volume and attach it to the run.
 */
export interface SandboxStorage {
  // fetches the branch into new storage for the id, and answers the commit
  create(id: string, fetch: SandboxFetch): Promise<string>
  // moves the files to another commit; only for a sandbox without changes
  fetch(id: string, fetch: SandboxFetch): Promise<string>
  state(id: string, signal?: AbortSignal): Promise<SandboxState>
  // the directory a run works in
  attach(id: string): Promise<string>
  // the bytes it takes, its git data included
  usage(id: string): Promise<number>
  // reading, searching and editing its files through the API
  files(id: string): SandboxFiles
  // commits the changes on top of the commit the sandbox is at and pushes that commit to
  // the branch; none when there is nothing to push. The sandbox stays where it is.
  push(id: string, push: SandboxPush): Promise<string | undefined>
  // moves the sandbox to a commit it pushed, keeping its files: its changes are then what
  // is not pushed yet
  moveTo(id: string, commit: string): Promise<void>
  remove(id: string): Promise<void>
  // the ids that have storage, to clean up what a crash left behind
  list(): Promise<string[]>
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
  // one git command or walk at a time per sandbox: the objects `state` writes are pruned
  // again, which must not meet another command that still needs them
  private readonly queues = new Map<string, Promise<unknown>>()
  // the sandboxes `usage` walked last: tasks only write while a run runs, between the
  // `state` it starts with and the `usage` it ends with, so the next `state` needs no walk
  private readonly walked = new Set<string>()

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
    maxBuffer?: number
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
      maxBuffer
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

  // `fn` with a copy of the sandbox's index, so neither the index nor the files change, and
  // what it wrote to the git data is pruned again. Files a task made unreadable are made
  // readable first: git would leave them out and call them unchanged. Holds the sandbox.
  // `afterRun` skips the walk when `usage` just walked the sandbox after a run.
  private withIndex<T>(
    id: string,
    signal: AbortSignal,
    fn: (run: SandboxGit['run']) => Promise<T>,
    afterRun = false
  ): Promise<T> {
    return this.exclusive(id, async () => {
      if (!(afterRun && this.walked.delete(id))) {
        await this.reclaim(id)
      }
      try {
        return await this.indexed(id, signal, fn)
      } finally {
        await this.prune(id)
      }
    })
  }

  private async indexed<T>(id: string, signal: AbortSignal, fn: (run: SandboxGit['run']) => Promise<T>): Promise<T> {
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
      return await fn((args, action, options = {}) =>
        this.git(id, args, this.readEnv({ ...options.env, GIT_INDEX_FILE: index }), signal, action, options.maxBuffer)
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
  files(id: string, maxChangesBytes?: number): SandboxFiles {
    return this.filesOf(id, (fn) => this.withIndex(id, AbortSignal.timeout(5 * 60 * 1000), fn), maxChangesBytes)
  }

  private filesOf(id: string, withIndex: SandboxGit['withIndex'], maxChangesBytes?: number): SandboxFiles {
    const timeout = () => AbortSignal.timeout(5 * 60 * 1000)
    return new HostSandboxFiles(
      this.workTree(id),
      {
        run: (args, action, options = {}) =>
          this.git(id, args, this.readEnv(options.env), timeout(), action, options.maxBuffer),
        withIndex,
      },
      this.env,
      maxChangesBytes
    )
  }

  async create(id: string, fetch: SandboxFetch): Promise<string> {
    const root = this.root(id)
    // the sandboxes are their owners', nobody else on the machine reads them
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await mkdir(this.workTree(id), { recursive: true })
    try {
      await git(['init', '--quiet', '--bare', join(root, 'git')], fetch.env, fetch.signal, `sandbox ${id}`, 'create')
      return await this.checkout(id, fetch, true)
    } catch (e) {
      await this.remove(id)
      throw e
    }
  }

  async fetch(id: string, fetch: SandboxFetch): Promise<string> {
    return this.exclusive(id, () => this.checkout(id, fetch, false))
  }

  private async checkout(id: string, fetch: SandboxFetch, force: boolean): Promise<string> {
    if (!isValidRef(fetch.ref)) {
      throw new Error(`${JSON.stringify(fetch.ref.slice(0, 80))} is not a branch`)
    }
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
  async push(id: string, push: SandboxPush): Promise<string | undefined> {
    return this.exclusive(id, async () => {
      await this.reclaim(id)
      try {
        return await this.commitAndPush(id, push)
      } finally {
        await this.prune(id)
      }
    })
  }

  private async commitAndPush(id: string, push: SandboxPush): Promise<string | undefined> {
    const commit = await this.filesOf(id, (fn) => this.indexed(id, push.signal, fn)).commit(push.author)
    if (!commit) {
      return undefined
    }
    const run = (args: string[], action: string, env = this.readEnv()) => this.git(id, args, env, push.signal, action)
    await run(['update-ref', PUSHED_REF, commit], 'push')
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

  async moveTo(id: string, commit: string): Promise<void> {
    await this.exclusive(id, () =>
      this.git(id, ['reset', '--quiet', commit], this.readEnv(), AbortSignal.timeout(5 * 60 * 1000), 'move')
    )
  }

  // The tree is written with an index of its own, so neither the sandbox's index nor its
  // files change, and what it wrote to the git data is pruned again. Files a task made
  // unreadable are made readable first: git would leave them out and call the sandbox
  // clean.
  async state(id: string, signal: AbortSignal = AbortSignal.timeout(5 * 60 * 1000)): Promise<SandboxState> {
    return this.withIndex(
      id,
      signal,
      async (run) => {
        await run(['add', '--all', '--', '.'], 'read')
        const tree = (await run(['write-tree'], 'read')).trim()
        const [commit, base] = (await run(['rev-parse', 'HEAD', 'HEAD^{tree}'], 'read')).trim().split('\n')
        return { commit, tree, clean: tree === base }
      },
      true
    )
  }

  async attach(id: string): Promise<string> {
    const files = this.workTree(id)
    const stats = await lstat(files).catch(() => undefined)
    if (!stats?.isDirectory()) {
      throw new Error(`the sandbox ${id} has no files on this server`)
    }
    return files
  }

  // What a task wrote is counted whatever it did to the modes, and with the volumes of its
  // outputs. Symbolic links are counted, not followed: a link a task made points anywhere.
  async usage(id: string): Promise<number> {
    return this.exclusive(id, async () => {
      const bytes = await this.reclaim(id)
      this.walked.add(id)
      return bytes + ((await this.containers?.volumeBytes(this.workTree(id)).catch(() => 0)) ?? 0)
    })
  }

  async remove(id: string): Promise<void> {
    await this.exclusive(id, async () => {
      this.walked.delete(id)
      await this.reclaim(id).catch(() => undefined)
      await rm(this.root(id), { recursive: true, force: true, maxRetries: 3 })
      // without docker there is nothing to remove now; volumes stay labelled with the files
      await this.containers?.removeVolumes(this.workTree(id)).catch(() => undefined)
    })
  }

  // Walks the sandbox, makes every directory and file the server's user can read and write
  // (a task runs as that user and may have taken its own permissions away) and answers the
  // bytes. What a container left as another user is given back through a container first.
  private async reclaim(id: string): Promise<number> {
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
  private async walk(root: string): Promise<number> {
    let bytes = 0
    let pending = [root]
    while (pending.length > 0) {
      const directories = pending.slice(0, WALK_DIRECTORIES)
      pending = pending.slice(WALK_DIRECTORIES)
      for (const found of await Promise.all(directories.map((directory) => this.walkDirectory(directory, root)))) {
        bytes += found.bytes
        pending.push(...found.directories)
      }
    }
    return bytes
  }

  private async walkDirectory(current: string, root: string): Promise<{ bytes: number; directories: string[] }> {
    await ensureMode(current, 0o700)
    const entries = await readdir(current, { withFileTypes: true }).catch((e) => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' && current !== root) {
        return []
      }
      throw e
    })
    const directories: string[] = []
    let bytes = 0
    for (let start = 0; start < entries.length; start += WALK_ENTRIES) {
      const sizes = await Promise.all(
        entries.slice(start, start + WALK_ENTRIES).map(async (entry) => {
          const path = join(current, entry.name)
          if (entry.isDirectory()) {
            directories.push(path)
            return 0
          }
          // one lstat for the mode and the size; a link is counted, not followed
          return (await ensureMode(path, entry.isFile() ? 0o600 : 0))?.size ?? 0
        })
      )
      bytes += sizes.reduce((sum, size) => sum + size, 0)
    }
    return { bytes, directories }
  }

  async list(): Promise<string[]> {
    // only a server that never kept a sandbox has no directory; any other error is one
    const entries = await readdir(this.directory, { withFileTypes: true }).catch((e) => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw e
    })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  }
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
