import { mkdir, readdir, readFile, rename, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { Environment } from '../executer/environment'
import { Annotations, Bundle, hashBundle, HASH_PATTERN } from '../remote/bundle'
import { DefinitionInputs, DefinitionError, PlanOptions, PlanPolicy, planBundle, TaskPlan } from './plan'

export interface DefinitionVersion {
  // sha256:<hex> of the bundle, see hashBundle: the only name a version has
  hash: string
  entry: string
  publishedAt: string
  publishedBy: { iss: string; sub: string }
  // when somebody else proposed it, who approved it
  approvedBy?: { iss: string; sub: string }
  // where the publisher says it comes from, as of its first publish
  annotations?: Annotations
  // what a run can ask for
  tasks: string[]
  services: string[]
  // what each task works on, so a client knows which of its files to send;
  // versions published before this was recorded have none
  inputs?: Record<string, DefinitionInputs>
  // what each task and service does and the accounts it uses; versions published
  // before this was recorded have none, and none of them runs on a server
  plan?: Record<string, TaskPlan>
  // every account the version uses
  accounts?: string[]
  // pulled back: no run starts from it, but it stays for the record
  yanked?: { at: string; by: { iss: string; sub: string }; reason?: string }
}

export { DefinitionError, inspectBundle } from './plan'
export type { DefinitionInputs, InspectedBundle, TaskPlan } from './plan'

interface Stored {
  version: DefinitionVersion
  // where it is kept: `<hex>.json`, or `<name>/<hex>.json` for a version published
  // when build files still had names
  file: string
  legacy: boolean
}

// The published build files: immutable versions, each named by its hash and by
// nothing else, so whoever publishes can't make one look like the follower of
// another. They are kept in files, so a restart doesn't forget what runs were
// started from.
export class DefinitionStore {
  private readonly versions = new Map<string, Stored>()

  constructor(
    private readonly directory: string,
    // the environment a build file is read with: on a server, the hosted one
    private readonly environment: Environment,
    private readonly options: { policy?: PlanPolicy; now?: () => number } = {}
  ) {
    this.now = options.now ?? Date.now
  }

  private readonly now: () => number

  async load(): Promise<void> {
    let entries: string[] = []
    try {
      entries = await readdir(this.directory)
    } catch {
      return // nothing was published yet
    }
    for (const entry of entries) {
      const path = join(this.directory, entry)
      if ((await stat(path)).isDirectory()) {
        // a name of an older server: its versions are versions like any other
        for (const file of await readdir(path)) {
          await this.read(join(path, file), true)
        }
      } else {
        await this.read(path, false)
      }
    }
  }

  // newest first
  list(): DefinitionVersion[] {
    return [...this.versions.values()]
      .map((stored) => stored.version)
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
  }

  find(hash: string): DefinitionVersion | undefined {
    return this.versions.get(hash)?.version
  }

  /**
   * Pulls a version back (or, with `undo`, lets it go on). The version is rewritten in
   * place, its files stay: a run that was started from it has them.
   */
  async yank(
    hash: string,
    by: { iss: string; sub: string },
    options: { reason?: string; undo?: boolean } = {}
  ): Promise<DefinitionVersion | undefined> {
    const stored = this.versions.get(hash)
    const version = stored?.version
    if (!stored || !version || Boolean(version.yanked) === !options.undo) {
      return version
    }
    const bundle = await this.files(version)
    if (!bundle) {
      return version
    }
    const next: DefinitionVersion = { ...version }
    if (options.undo) {
      delete next.yanked
    } else {
      next.yanked = {
        at: new Date(this.now()).toISOString(),
        by: { iss: by.iss, sub: by.sub },
        ...(options.reason ? { reason: options.reason } : {}),
      }
    }
    // a version of an older server is written as `<hex>.json`, which counts over the
    // copies it may have under several names
    const file = this.fileOf(hash)
    await this.write(file, next, bundle)
    stored.file = file
    stored.legacy = false
    // the same object, so whoever holds the version sees it
    Object.keys(version).forEach((key) => delete (version as any)[key])
    Object.assign(version, next)
    return version
  }

  async files(version: DefinitionVersion): Promise<Bundle | undefined> {
    const stored = this.versions.get(version.hash)
    try {
      return stored ? JSON.parse(await readFile(stored.file, 'utf8')).bundle : undefined
    } catch {
      return undefined
    }
  }

  // Reads a bundle the way a run would and says what it would be as a version;
  // `existing` is the published version with the same hash, if there is one.
  async prepare(
    bundle: Bundle,
    publisher: { iss: string; sub: string },
    // a proposal is read before anybody trusts it: it may not make the server fetch
    options: { noRemote?: PlanOptions['noRemote']; annotations?: Annotations } = {}
  ): Promise<{ version: DefinitionVersion; existing?: DefinitionVersion }> {
    const hash = hashBundle(bundle)
    const existing = this.find(hash)
    if (existing) {
      return { version: existing, existing }
    }
    const { tasks, services, inputs, plan, accounts } = await planBundle(bundle, this.environment, {
      policy: this.options.policy,
      noRemote: options.noRemote,
    })
    return {
      version: {
        hash,
        entry: bundle.entry,
        publishedAt: new Date(this.now()).toISOString(),
        publishedBy: { iss: publisher.iss, sub: publisher.sub },
        ...(options.annotations && Object.keys(options.annotations).length > 0
          ? { annotations: { ...options.annotations } }
          : {}),
        tasks,
        services,
        inputs,
        plan,
        accounts,
      },
    }
  }

  // Publishing what already is there changes nothing and says so, its annotations
  // included: they stay those of the first publish.
  async publish(
    bundle: Bundle,
    publisher: { iss: string; sub: string },
    options: { approvedBy?: { iss: string; sub: string }; annotations?: Annotations } = {}
  ): Promise<{ version: DefinitionVersion; created: boolean }> {
    const { approvedBy } = options
    const prepared = await this.prepare(bundle, publisher, { annotations: options.annotations })
    if (prepared.existing) {
      return { version: prepared.existing, created: false }
    }
    const version: DefinitionVersion = {
      ...prepared.version,
      publishedAt: new Date(this.now()).toISOString(),
      ...(approvedBy ? { approvedBy: { iss: approvedBy.iss, sub: approvedBy.sub } } : {}),
    }
    if (!HASH_PATTERN.test(version.hash)) {
      throw new DefinitionError('invalid hash')
    }
    const file = this.fileOf(version.hash)
    await mkdir(this.directory, { recursive: true })
    await this.write(file, version, bundle)
    this.versions.set(version.hash, { version, file, legacy: false })
    return { version, created: true }
  }

  private fileOf(hash: string): string {
    return join(this.directory, `${hash.slice('sha256:'.length)}.json`)
  }

  private async read(file: string, legacy: boolean): Promise<void> {
    if (!file.endsWith('.json')) {
      return
    }
    const { version } = JSON.parse(await readFile(file, 'utf8'))
    // the name an older server kept with it means nothing now
    delete version.name
    const stored = this.versions.get(version.hash)
    if (stored && !stored.legacy) {
      return // `<hex>.json` is what was written last
    }
    // published under two names, it is still one version: yanked under either name, it
    // stays yanked, else the first one counts
    const known = stored?.version
    const first =
      !legacy ||
      !known ||
      (Boolean(version.yanked) === Boolean(known.yanked) && version.publishedAt < known.publishedAt)
    if (first || (version.yanked && !known?.yanked)) {
      this.versions.set(version.hash, { version, file, legacy })
    }
  }

  private async write(file: string, version: DefinitionVersion, bundle: Bundle): Promise<void> {
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
    await writeFile(temporary, JSON.stringify({ version, bundle }), { flag: 'wx' })
    await rename(temporary, file)
  }
}
