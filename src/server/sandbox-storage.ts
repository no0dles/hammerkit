import { randomBytes } from 'crypto'
import { copyFile, lstat, mkdir, readdir, rm } from 'fs/promises'
import { join } from 'path'
import { git, isValidRef } from './git-checkout'

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
  constructor(
    private readonly directory: string,
    // the environment of git when it reads a sandbox: the variables runs see
    private readonly env: { [key: string]: string | undefined }
  ) {}

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

  // The tree is written with an index of its own, so neither the sandbox's index nor its
  // files change.
  async state(id: string, signal: AbortSignal = AbortSignal.timeout(5 * 60 * 1000)): Promise<SandboxState> {
    const root = this.root(id)
    const index = join(root, `index-${randomBytes(6).toString('hex')}`)
    const env: { [key: string]: string } = { GIT_INDEX_FILE: index }
    for (const [key, value] of Object.entries(this.env)) {
      if (value !== undefined && key !== 'GIT_INDEX_FILE') {
        env[key] = value
      }
    }
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

  // Symbolic links are counted, not followed: a link a task made points anywhere.
  async usage(id: string): Promise<number> {
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

  async remove(id: string): Promise<void> {
    await rm(this.root(id), { recursive: true, force: true, maxRetries: 3 })
  }

  async list(): Promise<string[]> {
    const entries = await readdir(this.directory, { withFileTypes: true }).catch(() => [])
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  }
}
