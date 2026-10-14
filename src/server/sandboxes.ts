import { randomBytes } from 'crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { formatSize } from '../utils/units'
import { assertBranchName, isValidBranch, RefError, remoteBranch } from './git-checkout'
import { Principal } from './oauth'
import { RepoAccess } from './repo-access'
import { SANDBOX_ID_PATTERN } from './runs'
import { matchesRef } from './repo'
import { EditedFile, EditOp, PatchAuthor, SandboxFiles } from './sandbox-files'
import {
  SandboxAttachment,
  SandboxKey,
  SandboxPushConflict,
  SandboxPushFailed,
  SandboxState,
  SandboxStorage,
} from './sandbox-storage'

// How long creating a sandbox or moving it to another commit may take
const FETCH_TIMEOUT_MS = 10 * 60 * 1000
// how old storage without a record has to be before a start removes it
const ORPHAN_GRACE_MS = 60 * 60 * 1000

type Owner = Pick<Principal, 'iss' | 'sub'>

/**
 * A checkout of a repository that belongs to one caller and that runs work on. It is
 * created from a ref with the read credential of the operator's sources, stays until it is
 * deleted, and counts against the limits of its owner.
 */
export interface Sandbox {
  id: string
  owner: { iss: string; sub: string }
  // `host/path`, as a ref run names it
  repo: string
  // what it was fetched from last, and the commit that was
  ref: string
  commit: string
  // what it takes on the server, measured after it was fetched and after each run
  bytes: number
  createdAt: string
  lastUsedAt: string
  // the branches it pushed, and the commit it pushed to each last
  pushed?: { [branch: string]: string }
}

export class SandboxError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413 | 502 | 507,
    message: string
  ) {
    super(message)
  }
}

export interface SandboxLimits {
  // sandboxes of one caller
  count: number
  // bytes of one caller's sandboxes together
  bytes: number
  // bytes of all sandboxes on the server
  total: number
}

// What the sandboxes need to know of the runs: the run that holds a sandbox (one that
// waits for an approval, is queued or runs on it), and a way to stop them all.
export interface SandboxRuns {
  holder(id: string): string | undefined
  // cancels the runs on the sandbox and resolves when none of them runs anymore
  stop(id: string): Promise<void>
}

export interface SandboxRegistryOptions {
  storage: SandboxStorage
  // where the records of the sandboxes are kept
  records: string
  limits: SandboxLimits
  repos: Pick<RepoAccess, 'url' | 'credentials' | 'pushCredentials' | 'source' | 'resolve' | 'scrub'>
  now?: () => number
  log?: (line: string) => void
}

/**
 * The sandboxes of a server: who owns which, the limits, and one change at a time per
 * sandbox. Everything is scoped to the owner: somebody else's sandbox is "not found".
 */
export class SandboxRegistry {
  private readonly sandboxes = new Map<string, Sandbox>()
  // creates that are under way, so they count against the limit of their owner, with the
  // bytes they take once they were measured
  private readonly creating = new Map<string, { owner: Owner; bytes: number }>()
  private readonly deleting = new Set<string>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly now: () => number
  private runs: SandboxRuns = { holder: () => undefined, stop: async () => undefined }

  constructor(private readonly options: SandboxRegistryOptions) {
    this.now = options.now ?? Date.now
  }

  // The runs are made after the executor, which needs the sandboxes.
  useRuns(runs: SandboxRuns): void {
    this.runs = runs
  }

  get limits(): SandboxLimits {
    return this.options.limits
  }

  /**
   * Takes back the sandboxes of a previous start. Storage without a record is what a
   * create left behind when the server stopped, and a record without storage is of no use.
   */
  async load(): Promise<void> {
    const { storage, records } = this.options
    // no records at all only on a first start: a directory that can't be read is an error,
    // not a reason to remove every sandbox
    const names = await readdir(records).catch((e) => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return [] as string[]
      }
      throw e
    })
    // a record that can't be read keeps its files, for the operator to look at
    const recorded = new Set(names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)))
    const stored = await storage.list()
    const ids = new Set(stored.map((entry) => entry.id))
    for (const name of names) {
      if (!name.endsWith('.json')) {
        await rm(join(records, name), { force: true })
        continue
      }
      try {
        const sandbox = JSON.parse(await readFile(join(records, name), 'utf8')) as Sandbox
        if (!SANDBOX_ID_PATTERN.test(sandbox.id) || `${sandbox.id}.json` !== name) {
          throw new Error('not a sandbox record')
        }
        if (!ids.has(sandbox.id)) {
          this.options.log?.(`drop sandbox ${sandbox.id}: its files are gone`)
          await rm(join(records, name), { force: true })
          continue
        }
        this.sandboxes.set(sandbox.id, sandbox)
      } catch {
        this.options.log?.(`skip sandbox record ${name}: it can not be read`)
      }
    }
    const now = Date.now()
    for (const entry of stored) {
      if (recorded.has(entry.id) || !entry.remove) {
        continue
      }
      // a sandbox being created has storage before its record
      if (entry.createdAt && now - entry.createdAt.getTime() < ORPHAN_GRACE_MS) {
        continue
      }
      this.options.log?.(`remove the storage of sandbox ${entry.id}: it has no record`)
      await entry.remove()
    }
  }

  // oldest first
  list(owner: Owner): Sandbox[] {
    return [...this.sandboxes.values()]
      .filter((sandbox) => owns(owner, sandbox))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(copy)
  }

  get(owner: Owner, id: string): Sandbox | undefined {
    const sandbox = this.sandboxes.get(id)
    return sandbox && owns(owner, sandbox) && !this.deleting.has(id) ? copy(sandbox) : undefined
  }

  holder(id: string): string | undefined {
    return this.runs.holder(id)
  }

  usage(owner: Owner): { count: number; bytes: number } {
    const mine = this.list(owner)
    const creating = [...this.creating.values()].filter((create) => owns(owner, create.owner))
    return {
      count: mine.length + creating.length,
      bytes: [...mine, ...creating].reduce((sum, sandbox) => sum + sandbox.bytes, 0),
    }
  }

  // Whether the owner is over their bytes, so no more runs grow their sandboxes.
  overLimit(owner: Owner): string | undefined {
    const { bytes } = this.usage(owner)
    return bytes > this.limits.bytes
      ? `your sandboxes take ${formatSize(bytes)}, more than your limit of ${formatSize(
          this.limits.bytes
        )}, delete a sandbox`
      : undefined
  }

  /**
   * Fetches a branch of a repository into a new sandbox of the owner. Whether they may is the
   * caller's to decide (`decideSandbox`); this checks the limits.
   */
  async create(owner: Owner, repo: string, ref: string): Promise<Sandbox> {
    const { limits, storage, repos } = this.options
    const usage = this.usage(owner)
    if (usage.count >= limits.count) {
      throw new SandboxError(413, `you have ${usage.count} sandboxes, the limit is ${limits.count}: delete one`)
    }
    if (usage.bytes >= limits.bytes) {
      throw new SandboxError(
        413,
        `your sandboxes take ${formatSize(usage.bytes)}, your limit is ${formatSize(limits.bytes)}: delete one`
      )
    }
    if (this.total() >= limits.total) {
      throw new SandboxError(507, 'the server has no room for another sandbox')
    }
    const id = `sbx_${randomBytes(12).toString('base64url')}`
    const key: SandboxKey = { id, owner: { iss: owner.iss, sub: owner.sub } }
    this.creating.set(id, { owner: { iss: owner.iss, sub: owner.sub }, bytes: 0 })
    try {
      const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
      await this.resolve(repo, ref, signal)
      const credentials = await repos.credentials(repo)
      let commit: string
      try {
        commit = await storage.create(key, { url: repos.url(repo), ref, env: credentials.env, signal })
      } catch (e) {
        // the storage's own limits (a quota on a cluster) are said as they are
        throw e instanceof SandboxError ? e : new SandboxError(502, repos.scrub(e, credentials.values).message)
      }
      const bytes = await storage.usage(key)
      // checked against what is there now, other creates of the owner included, and taken
      // before anything else can check: no await between the two
      const used = this.usage(owner).bytes
      const problem =
        used + bytes > limits.bytes
          ? new SandboxError(
              413,
              `${repo} at ${ref} takes ${formatSize(bytes)}, more than is left of your limit of ${formatSize(
                limits.bytes
              )}`
            )
          : this.total() + bytes > limits.total
            ? new SandboxError(507, 'the server has no room for another sandbox')
            : undefined
      if (problem) {
        await storage.remove(key)
        throw problem
      }
      this.creating.set(id, { owner: { iss: owner.iss, sub: owner.sub }, bytes })
      const at = this.timestamp()
      const sandbox: Sandbox = {
        id,
        owner: { iss: owner.iss, sub: owner.sub },
        repo,
        ref,
        commit,
        bytes,
        createdAt: at,
        lastUsedAt: at,
      }
      await this.save(sandbox)
      this.sandboxes.set(id, sandbox)
      return copy(sandbox)
    } finally {
      this.creating.delete(id)
    }
  }

  /**
   * Moves a sandbox to the commit a ref points to now. Only a sandbox without changes is
   * moved, and none that a run holds: the files of a run are not changed under it.
   */
  async fetch(owner: Owner, id: string, ref: string): Promise<Sandbox> {
    return this.withLock(id, async () => {
      const sandbox = this.mine(owner, id)
      this.mustBeFree(id)
      const state = await this.options.storage.state(keyOf(sandbox))
      if (!state.clean) {
        throw new SandboxError(409, `the sandbox ${id} has changes, a fetch would mix them with another commit`)
      }
      const { storage, repos } = this.options
      const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
      await this.resolve(sandbox.repo, ref, signal)
      const credentials = await repos.credentials(sandbox.repo)
      try {
        sandbox.commit = await storage.fetch(keyOf(sandbox), {
          url: repos.url(sandbox.repo),
          ref,
          env: credentials.env,
          signal,
        })
      } catch (e) {
        throw new SandboxError(502, repos.scrub(e, credentials.values).message)
      }
      sandbox.ref = ref
      sandbox.bytes = await storage.usage(keyOf(sandbox))
      sandbox.lastUsedAt = this.timestamp()
      await this.save(sandbox)
      return copy(sandbox)
    })
  }

  /**
   * Commits the changes of a sandbox as its owner and pushes them to a branch the operator
   * allows (`sources[].push.branches`). The branch must not exist yet, or be one this
   * sandbox pushed and still at what it pushed: a sandbox never writes over somebody
   * else's work. The sandbox is at the pushed commit afterwards, so its changes are what
   * is not pushed yet and the next push to the branch adds a commit to it.
   */
  // `allowed` are the branches the owner's entitlements let them push to from a sandbox of
  // its repository
  async push(owner: Owner, id: string, branch: string, author: PatchAuthor, allowed: string[]): Promise<Sandbox> {
    return this.withLock(id, async () => {
      const sandbox = this.mine(owner, id)
      const { storage, repos } = this.options
      if (!repos.source(sandbox.repo)?.secret) {
        throw new SandboxError(403, `this server does not push to ${sandbox.repo}`)
      }
      if (allowed.length === 0) {
        throw new SandboxError(403, `you may not push from sandboxes of ${sandbox.repo}`)
      }
      if (!isValidBranch(branch)) {
        throw new SandboxError(400, `${JSON.stringify(branch.slice(0, 80))} is not a branch name`)
      }
      if (!matchesRef(allowed, branch)) {
        throw new SandboxError(403, `you may only push to ${allowed.join(', ')} of ${sandbox.repo}`)
      }
      this.mustBeFree(id)
      if ((await storage.state(keyOf(sandbox))).clean) {
        throw new SandboxError(409, `the sandbox ${id} has no changes to push`)
      }
      const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
      const url = repos.url(sandbox.repo)
      const read = await repos.credentials(sandbox.repo)
      let current: string | undefined
      try {
        current = await remoteBranch(url, branch, read.env, signal)
      } catch (e) {
        throw new SandboxError(502, repos.scrub(e, read.values).message)
      }
      const pushed = sandbox.pushed?.[branch]
      if (current && current !== pushed) {
        throw new SandboxError(
          409,
          pushed
            ? `${branch} moved since this sandbox pushed it, push to a new branch`
            : `${branch} exists and this sandbox did not push it, push to a new branch`
        )
      }
      let write: { env: { [key: string]: string }; values: string[] }
      try {
        write = await repos.pushCredentials(sandbox.repo)
      } catch (e) {
        // what the provider said is the operator's: it can name accounts, projects and paths
        this.options.log?.(`sandbox push ${id}: ${e instanceof Error ? e.message : e}`)
        throw new SandboxError(502, 'the server could not read its credential to push')
      }
      let commit: string | undefined
      try {
        commit = await storage.push(keyOf(sandbox), {
          url,
          branch,
          expect: current ?? null,
          author,
          env: write.env,
          signal,
        })
      } catch (e) {
        if (e instanceof SandboxPushConflict) {
          throw new SandboxError(409, e.message)
        }
        // the lease refuses a branch that somebody created or moved since it was read; and a
        // push that failed late (a timeout after the remote answered) may have gone through
        const now = await remoteBranch(url, branch, read.env, AbortSignal.timeout(30 * 1000)).catch(() => current)
        if (e instanceof SandboxPushFailed && now === e.commit) {
          commit = e.commit
        } else if (now !== current) {
          throw new SandboxError(409, `${branch} changed while the sandbox pushed to it, push to a new branch`)
        } else {
          throw new SandboxError(502, repos.scrub(e, [...write.values, ...read.values]).message)
        }
      }
      if (!commit) {
        // only files the API never reads changed: the deny list stays on the server
        throw new SandboxError(409, `the sandbox ${id} has no changes to push`)
      }
      // the branch is this sandbox's from now on, whatever happens next
      sandbox.pushed = { ...sandbox.pushed, [branch]: commit }
      sandbox.lastUsedAt = this.timestamp()
      await this.save(sandbox)
      try {
        await storage.moveTo(keyOf(sandbox), commit)
      } catch (e) {
        throw new SandboxError(
          502,
          `pushed ${commit} to ${branch}, but could not move the sandbox to it: ${e instanceof Error ? e.message : e}`
        )
      }
      sandbox.commit = commit
      sandbox.ref = branch
      sandbox.bytes = await storage.usage(keyOf(sandbox))
      await this.save(sandbox)
      return copy(sandbox)
    })
  }

  // Cancels the runs on the sandbox, waits for them to stop and removes its files.
  async remove(owner: Owner, id: string): Promise<boolean> {
    const sandbox = this.get(owner, id)
    if (!sandbox) {
      return false
    }
    this.deleting.add(id)
    try {
      await this.runs.stop(id)
      await this.withLock(id, async () => {
        await this.options.storage.remove(keyOf(sandbox))
        await rm(join(this.options.records, `${id}.json`), { force: true })
        this.sandboxes.delete(id)
      })
      return true
    } finally {
      this.deleting.delete(id)
    }
  }

  /**
   * Runs `fn` while nothing else changes the sandbox: a fetch, a delete, or another run
   * being submitted. The sandbox has to be the owner's and not on its way out.
   */
  async withSandbox<T>(owner: Owner, id: string, fn: (sandbox: Sandbox) => Promise<T>): Promise<T> {
    return this.withLock(id, async () => fn(copy(this.mine(owner, id))))
  }

  // The files of one of the owner's sandboxes, to read one: while a run holds it too,
  // where the storage can read it then.
  files(owner: Owner, id: string): SandboxFiles {
    const sandbox = this.mine(owner, id)
    if (!this.options.storage.readsWhileHeld) {
      this.mustBeFree(id)
    }
    return this.options.storage.files(keyOf(sandbox))
  }

  /**
   * A read that walks the files with other programs (ripgrep, git): between two batches of
   * edits, and not while a run holds the sandbox. Those programs follow a directory that a
   * task swaps for a link while they read; a read of one file checks what it opened.
   */
  async read<T>(owner: Owner, id: string, fn: (files: SandboxFiles) => Promise<T>): Promise<T> {
    return this.withLock(id, async () => {
      const sandbox = this.mine(owner, id)
      this.mustBeFree(id)
      return fn(this.options.storage.files(keyOf(sandbox)))
    })
  }

  /**
   * Applies a batch of edits to the files of a sandbox, all of them or none. Not while a run
   * holds the sandbox, and not past the owner's bytes.
   */
  async edit(owner: Owner, id: string, ops: EditOp[], dryRun = false): Promise<EditedFile[]> {
    return this.withLock(id, async () => {
      const sandbox = this.mine(owner, id)
      this.mustBeFree(id)
      const plan = await this.options.storage.files(keyOf(sandbox)).plan(ops)
      if (dryRun || plan.files.length === 0) {
        return plan.files
      }
      if (plan.bytes > 0) {
        const { limits } = this.options
        const used = this.usage(owner).bytes
        if (used + plan.bytes > limits.bytes) {
          throw new SandboxError(
            413,
            `the edits take ${formatSize(plan.bytes)} more, your sandboxes take ${formatSize(
              used
            )} of your limit of ${formatSize(limits.bytes)}: delete a sandbox`
          )
        }
        if (this.total() + plan.bytes > limits.total) {
          throw new SandboxError(507, 'the server has no room for these edits')
        }
      }
      await plan.commit()
      sandbox.bytes = Math.max(0, sandbox.bytes + plan.bytes)
      sandbox.lastUsedAt = this.timestamp()
      await this.save(sandbox)
      return plan.files
    })
  }

  state(id: string, signal?: AbortSignal): Promise<SandboxState> {
    return this.options.storage.state(keyOf(this.existing(id)), signal)
  }

  // What a run works on, `into` a directory of the run when the storage copies the files;
  // the run is the sandbox's use.
  async attach(id: string, into: string): Promise<SandboxAttachment> {
    const sandbox = this.existing(id)
    sandbox.lastUsedAt = this.timestamp()
    await this.save(sandbox)
    return this.options.storage.attach(keyOf(sandbox), into)
  }

  // What a sandbox takes after a run wrote to it.
  async measure(id: string): Promise<void> {
    const sandbox = this.sandboxes.get(id)
    if (!sandbox || this.deleting.has(id)) {
      return
    }
    sandbox.bytes = await this.options.storage.usage(keyOf(sandbox))
    await this.save(sandbox)
  }

  private existing(id: string): Sandbox {
    const sandbox = this.sandboxes.get(id)
    if (!sandbox || this.deleting.has(id)) {
      throw new Error(`the sandbox ${id} was deleted`)
    }
    return sandbox
  }

  private mine(owner: Owner, id: string): Sandbox {
    const sandbox = this.sandboxes.get(id)
    if (!sandbox || !owns(owner, sandbox) || this.deleting.has(id)) {
      throw new SandboxError(404, 'not found')
    }
    return sandbox
  }

  private mustBeFree(id: string): void {
    const run = this.runs.holder(id)
    if (run) {
      throw new SandboxError(409, `the run ${run} holds the sandbox ${id}, wait for it to finish or cancel it`)
    }
  }

  // a sandbox starts from a branch, never a tag or a commit
  private async resolve(repo: string, ref: string, signal: AbortSignal): Promise<string> {
    try {
      assertBranchName(ref)
      return await this.options.repos.resolve(repo, ref, signal, 'branch')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      throw e instanceof RefError
        ? new SandboxError(400, message)
        : new SandboxError(502, `could not resolve ${ref}: ${message}`)
    }
  }

  private total(): number {
    return [...this.sandboxes.values(), ...this.creating.values()].reduce((sum, sandbox) => sum + sandbox.bytes, 0)
  }

  private withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    const settled = next.then(
      () => undefined,
      () => undefined
    )
    this.locks.set(id, settled)
    void settled.then(() => {
      if (this.locks.get(id) === settled) {
        this.locks.delete(id)
      }
    })
    return next
  }

  private async save(sandbox: Sandbox): Promise<void> {
    const directory = this.options.records
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const file = join(directory, `${sandbox.id}.json`)
    const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(temporary, JSON.stringify(sandbox), { mode: 0o600 })
    await rename(temporary, file)
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString()
  }
}

function owns(owner: Owner, sandbox: Owner | Sandbox): boolean {
  const of = 'owner' in sandbox ? sandbox.owner : sandbox
  return of.iss === owner.iss && of.sub === owner.sub
}

function keyOf(sandbox: Sandbox): SandboxKey {
  return { id: sandbox.id, owner: sandbox.owner }
}

function copy(sandbox: Sandbox): Sandbox {
  return {
    ...sandbox,
    owner: { ...sandbox.owner },
    ...(sandbox.pushed ? { pushed: { ...sandbox.pushed } } : {}),
  }
}
