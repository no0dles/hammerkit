import { randomBytes } from 'crypto'
import { Stats } from 'fs'
import { chmod, copyFile, lstat, mkdir, readdir, readlink, rm, stat, utimes } from 'fs/promises'
import { join, relative, sep } from 'path'
import { git, isValidRef } from './git-checkout'
import { SandboxContainers } from './sandbox-docker'

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
  // the sandboxes walked since a run last wrote to them, with the links the walk found: only
  // a run's tasks write to a sandbox, between its `attach` and the `usage` it ends with, so
  // until the next attach a `state` needs no walk
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

  private files(id: string): string {
    return join(this.root(id), 'files')
  }

  private async git(
    id: string,
    args: string[],
    env: { [key: string]: string },
    signal: AbortSignal,
    action: string,
    options?: { input?: string | Buffer; exitCodes?: number[] }
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

  // The tree is written with an index of its own, so neither the sandbox's index nor its
  // files change, and what it wrote to the git data is pruned again. Files a task made
  // unreadable are made readable first: git would leave them out and call the sandbox
  // clean.
  async state(id: string, signal: AbortSignal = AbortSignal.timeout(5 * 60 * 1000)): Promise<SandboxState> {
    return this.exclusive(id, async () => {
      const links = this.walked.get(id) ?? (await this.walkOnce(id)).links
      return this.readState(id, signal, links)
    })
  }

  private async readState(id: string, signal: AbortSignal, links: string[]): Promise<SandboxState> {
    const root = this.root(id)
    const index = join(root, `index-${randomBytes(6).toString('hex')}`)
    const base: { [key: string]: string } = {}
    for (const [key, value] of Object.entries(this.env)) {
      if (value !== undefined && key !== 'GIT_INDEX_FILE') {
        base[key] = value
      }
    }
    // reading the files needs no configuration of the server's: a filter or attributes the
    // machine's git config names would run on files a task wrote
    base.GIT_CONFIG_NOSYSTEM = '1'
    // a file that is never there, which git reads as empty: Git for Windows refuses `\\.\nul`
    base.GIT_CONFIG_GLOBAL = join(this.directory, 'no-git-config')
    const env = { ...base, GIT_INDEX_FILE: index }
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
      // A link is written as a link and never walked: Git for Windows takes a junction for
      // a directory, and would read what a `mklink /J x C:\` of a task points to.
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

  // the links of the files that are still links and that git does not ignore, by their path
  // in the files ('/'-separated) and their target
  private async unignoredLinks(
    id: string,
    paths: string[],
    env: { [key: string]: string },
    signal: AbortSignal
  ): Promise<{ path: string; target: Buffer }[]> {
    const files = this.files(id)
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

  async attach(id: string): Promise<string> {
    const files = this.files(id)
    const stats = await lstat(files).catch(() => undefined)
    if (!stats?.isDirectory()) {
      throw new Error(`the sandbox ${id} has no files on this server`)
    }
    // the run's tasks write from now on
    this.walked.delete(id)
    this.attached.add(id)
    this.attaches.set(id, (this.attaches.get(id) ?? 0) + 1)
    return files
  }

  // What a task wrote is counted whatever it did to the modes, and with the volumes of its
  // outputs. Symbolic links are counted, not followed: a link a task made points anywhere.
  async usage(id: string): Promise<number> {
    return this.exclusive(id, async () => {
      // after a run: its tasks are done
      this.attached.delete(id)
      const { bytes } = await this.walkOnce(id)
      return bytes + ((await this.containers?.volumeBytes(this.files(id)).catch(() => 0)) ?? 0)
    })
  }

  async remove(id: string): Promise<void> {
    await this.exclusive(id, async () => {
      this.walked.delete(id)
      this.attached.delete(id)
      this.attaches.delete(id)
      await this.reclaim(id).catch(() => undefined)
      await rm(this.root(id), { recursive: true, force: true, maxRetries: 3 })
      // without docker there is nothing to remove now; volumes stay labelled with the files
      await this.containers?.removeVolumes(this.files(id)).catch(() => undefined)
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
