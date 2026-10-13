import { randomBytes } from 'crypto'
import { copyFile, lstat, mkdir, readdir, rm } from 'fs/promises'
import { join } from 'path'
import { git, isValidRef } from './git-checkout'
import { HostSandboxFiles, PatchAuthor, SandboxFiles, SandboxGit } from './sandbox-files'

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
  // fetches the ref into new storage for the sandbox, and answers the commit
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

/**
 * Sandboxes as directories below `directory`, one per sandbox: `files` is the checkout the
 * tasks work on, `git` its git data. The git data is kept outside of the files on purpose:
 * tasks write to the files, and a `.git/config` or a hook they wrote would be read by the
 * git of the server, which runs as the server's user. Every git command names its git
 * directory and work tree, and runs without hooks or a file system monitor.
 */
export class HostSandboxStorage implements SandboxStorage {
  readonly readsWhileHeld = true

  constructor(
    private readonly directory: string,
    // the environment of git when it reads a sandbox: the variables runs see
    private readonly env: { [key: string]: string | undefined }
  ) {}

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
        '-c',
        'advice.detachedHead=false',
        // the files are what the repository holds, on a Windows server too: the API answers
        // their bytes, and tasks read them in Linux containers
        '-c',
        'core.autocrlf=false',
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
    return { ...env, ...extra }
  }

  // `fn` with a copy of the sandbox's index, so neither the index nor the files change.
  private async withIndex<T>(id: string, signal: AbortSignal, fn: (run: SandboxGit['run']) => Promise<T>): Promise<T> {
    const root = this.root(id)
    const index = join(root, `index-${randomBytes(6).toString('hex')}`)
    try {
      await copyFile(join(root, 'git', 'index'), index).catch(() => undefined)
      return await fn((args, action, options = {}) =>
        this.git(id, args, this.readEnv({ ...options.env, GIT_INDEX_FILE: index }), signal, action, options.maxBuffer)
      )
    } finally {
      await rm(index, { force: true })
    }
  }

  files({ id }: SandboxKey): SandboxFiles {
    const timeout = () => AbortSignal.timeout(5 * 60 * 1000)
    return new HostSandboxFiles(
      this.workTree(id),
      {
        run: (args, action, options = {}) =>
          this.git(id, args, this.readEnv(options.env), timeout(), action, options.maxBuffer),
        withIndex: (fn) => this.withIndex(id, timeout(), fn),
      },
      this.env
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
    return this.checkout(id, fetch, false)
  }

  private async checkout(id: string, fetch: SandboxFetch, force: boolean): Promise<string> {
    if (!isValidRef(fetch.ref)) {
      throw new Error(`${JSON.stringify(fetch.ref.slice(0, 80))} is not a branch, tag or commit`)
    }
    await this.git(
      id,
      ['fetch', '--quiet', '--depth', '1', '--', fetch.url, fetch.ref],
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

  async push(key: SandboxKey, push: SandboxPush): Promise<string | undefined> {
    const { id } = key
    const commit = await this.files(key).commit(push.author)
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
    await this.git(id, ['reset', '--quiet', commit], this.readEnv(), AbortSignal.timeout(5 * 60 * 1000), 'move')
  }

  // The tree is written with an index of its own, so neither the sandbox's index nor its
  // files change.
  async state({ id }: SandboxKey, signal: AbortSignal = AbortSignal.timeout(5 * 60 * 1000)): Promise<SandboxState> {
    return this.withIndex(id, signal, async (run) => {
      await run(['add', '--all', '--', '.'], 'read')
      const tree = (await run(['write-tree'], 'read')).trim()
      const [commit, base] = (await run(['rev-parse', 'HEAD', 'HEAD^{tree}'], 'read')).trim().split('\n')
      return { commit, tree, clean: tree === base }
    })
  }

  // the run works in the sandbox itself
  async attach({ id }: SandboxKey): Promise<SandboxAttachment> {
    const files = this.workTree(id)
    const stats = await lstat(files).catch(() => undefined)
    if (!stats?.isDirectory()) {
      throw new Error(`the sandbox ${id} has no files on this server`)
    }
    return { directory: files }
  }

  // Symbolic links are counted, not followed: a link a task made points anywhere.
  async usage({ id }: SandboxKey): Promise<number> {
    let bytes = 0
    const pending = [this.root(id)]
    while (pending.length > 0) {
      const current = pending.pop() as string
      const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        const path = join(current, entry.name)
        if (entry.isDirectory()) {
          pending.push(path)
        } else {
          bytes += (await lstat(path).catch(() => undefined))?.size ?? 0
        }
      }
    }
    return bytes
  }

  async remove({ id }: SandboxKey): Promise<void> {
    await this.removeId(id)
  }

  private async removeId(id: string): Promise<void> {
    await rm(this.root(id), { recursive: true, force: true, maxRetries: 3 })
  }

  async list(): Promise<StoredSandbox[]> {
    const entries = await readdir(this.directory, { withFileTypes: true }).catch(() => [])
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ id: entry.name, remove: () => this.removeId(entry.name) }))
  }
}
