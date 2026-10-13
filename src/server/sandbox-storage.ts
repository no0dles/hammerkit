import { randomBytes } from 'crypto'
import { chmod, copyFile, lstat, mkdir, readdir, rm } from 'fs/promises'
import { join } from 'path'
import { git, isValidRef } from './git-checkout'
import { SandboxContainers } from './sandbox-docker'

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

/**
 * Where the files of sandboxes are kept. The registry of sandboxes, the API and the
 * executor only know a sandbox id and, while a run uses it, a directory; how the files are
 * stored is this interface's. A host keeps a directory per sandbox; a cluster would keep a
 * volume and attach it to the run.
 */
export interface SandboxStorage {
  // fetches the ref into new storage for the id, and answers the commit
  create(id: string, fetch: SandboxFetch): Promise<string>
  // moves the files to another commit; only for a sandbox without changes
  fetch(id: string, fetch: SandboxFetch): Promise<string>
  state(id: string, signal?: AbortSignal): Promise<SandboxState>
  // the directory a run works in
  attach(id: string): Promise<string>
  // the bytes it takes, its git data included
  usage(id: string): Promise<number>
  remove(id: string): Promise<void>
  // the ids that have storage, to clean up what a crash left behind
  list(): Promise<string[]>
}

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

  private files(id: string): string {
    return join(this.root(id), 'files')
  }

  private async git(
    id: string,
    args: string[],
    env: { [key: string]: string },
    signal: AbortSignal,
    action: string
  ): Promise<string> {
    const root = this.root(id)
    return git(
      [
        `--git-dir=${join(root, 'git')}`,
        `--work-tree=${this.files(id)}`,
        '-c',
        `core.hooksPath=${join(root, 'no-hooks')}`,
        '-c',
        'core.fsmonitor=false',
        '-c',
        'advice.detachedHead=false',
        '-c',
        'advice.addEmbeddedRepo=false',
        ...args,
      ],
      env,
      signal,
      `sandbox ${id}`,
      action
    )
  }

  async create(id: string, fetch: SandboxFetch): Promise<string> {
    const root = this.root(id)
    // the sandboxes are their owners', nobody else on the machine reads them
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await mkdir(this.files(id), { recursive: true })
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

  // The tree is written with an index of its own, so neither the sandbox's index nor its
  // files change, and what it wrote to the git data is pruned again. Files a task made
  // unreadable are made readable first: git would leave them out and call the sandbox
  // clean.
  async state(id: string, signal: AbortSignal = AbortSignal.timeout(5 * 60 * 1000)): Promise<SandboxState> {
    return this.exclusive(id, async () => {
      await this.reclaim(id)
      return this.readState(id, signal)
    })
  }

  private async readState(id: string, signal: AbortSignal): Promise<SandboxState> {
    const root = this.root(id)
    const index = join(root, `index-${randomBytes(6).toString('hex')}`)
    const base: { [key: string]: string } = {}
    for (const [key, value] of Object.entries(this.env)) {
      if (value !== undefined && key !== 'GIT_INDEX_FILE') {
        base[key] = value
      }
    }
    const env = { ...base, GIT_INDEX_FILE: index }
    try {
      await copyFile(join(root, 'git', 'index'), index).catch(() => undefined)
      await this.git(id, ['add', '--all', '--', '.'], env, signal, 'read')
      const tree = (await this.git(id, ['write-tree'], env, signal, 'read')).trim()
      const [commit, base] = (await this.git(id, ['rev-parse', 'HEAD', 'HEAD^{tree}'], env, signal, 'read'))
        .trim()
        .split('\n')
      return { commit, tree, clean: tree === base }
    } finally {
      await rm(index, { force: true })
      // the sandbox's own index and HEAD keep what they need
      await this.git(id, ['prune', '--expire=now'], base, AbortSignal.timeout(60_000), 'read').catch(() => undefined)
    }
  }

  async attach(id: string): Promise<string> {
    const files = this.files(id)
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
      return bytes + ((await this.containers?.volumeBytes(this.files(id)).catch(() => 0)) ?? 0)
    })
  }

  async remove(id: string): Promise<void> {
    await this.exclusive(id, async () => {
      await this.reclaim(id).catch(() => undefined)
      await rm(this.root(id), { recursive: true, force: true, maxRetries: 3 })
      await this.containers?.removeVolumes(this.files(id))
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

  private async walk(root: string): Promise<number> {
    let bytes = 0
    const pending = [root]
    while (pending.length > 0) {
      const current = pending.pop() as string
      await ensureMode(current, 0o700)
      const entries = await readdir(current, { withFileTypes: true }).catch((e) => {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT' && current !== root) {
          return []
        }
        throw e
      })
      for (const entry of entries) {
        const path = join(current, entry.name)
        if (entry.isDirectory()) {
          pending.push(path)
          continue
        }
        if (entry.isFile()) {
          await ensureMode(path, 0o600)
        }
        bytes += (await lstat(path).catch(() => undefined))?.size ?? 0
      }
    }
    return bytes
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

// adds the bits of the owner a path lacks; a path that is gone since it was listed is fine
async function ensureMode(path: string, bits: number): Promise<void> {
  const stats = await lstat(path).catch((e) => {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw e
  })
  if (stats && (stats.mode & bits) !== bits) {
    await chmod(path, (stats.mode & 0o7777) | bits)
  }
}
