import { mkdir, readdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'
import { Environment } from '../executer/environment'
import { Bundle, hashBundle, HASH_PATTERN } from '../remote/bundle'
import { DefinitionInputs, DefinitionError, PlanPolicy, planBundle, TaskPlan } from './plan'

export interface DefinitionVersion {
  name: string
  // sha256:<hex> of the bundle, see hashBundle
  hash: string
  entry: string
  publishedAt: string
  publishedBy: { iss: string; sub: string }
  // when somebody else proposed it, who approved it
  approvedBy?: { iss: string; sub: string }
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
  // pulled back: no run starts from it, and it is not `latest`, but it stays for the record
  yanked?: { at: string; by: { iss: string; sub: string }; reason?: string }
}

export { DefinitionError, inspectBundle } from './plan'
export type { DefinitionInputs, InspectedBundle, TaskPlan } from './plan'

// The published build files: immutable versions, each named by its hash. They
// are kept in files, so a restart doesn't forget what runs were started from.
export class DefinitionStore {
  private readonly versions = new Map<string, DefinitionVersion[]>()

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
    let names: string[] = []
    try {
      names = await readdir(this.directory)
    } catch {
      return // nothing was published yet
    }
    for (const name of names) {
      for (const file of await readdir(join(this.directory, name))) {
        if (!file.endsWith('.json')) {
          continue
        }
        const stored = JSON.parse(await readFile(join(this.directory, name, file), 'utf8'))
        this.add(stored.version)
      }
    }
  }

  names(): string[] {
    return [...this.versions.keys()].sort()
  }

  // newest first
  list(name: string): DefinitionVersion[] {
    return this.has(name) ? [...(this.versions.get(name) as DefinitionVersion[])] : []
  }

  // a hash, or `latest` for the version published last that is not yanked
  find(name: string, hash: string): DefinitionVersion | undefined {
    const versions = this.list(name)
    return hash === 'latest' ? versions.find((v) => !v.yanked) : versions.find((v) => v.hash === hash)
  }

  /**
   * Pulls a version back (or, with `undo`, lets it go on). The version is rewritten in
   * place, its files stay: a run that was started from it has them.
   */
  async yank(
    name: string,
    hash: string,
    by: { iss: string; sub: string },
    options: { reason?: string; undo?: boolean } = {}
  ): Promise<DefinitionVersion | undefined> {
    const version = this.versions.get(name)?.find((v) => v.hash === hash)
    if (!version || Boolean(version.yanked) === !options.undo) {
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
    const file = this.file(name, hash)
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
    await writeFile(temporary, JSON.stringify({ version: next, bundle }), { flag: 'wx' })
    await rename(temporary, file)
    // the same object, so whoever holds the version sees it
    Object.keys(version).forEach((key) => delete (version as any)[key])
    Object.assign(version, next)
    return version
  }

  async files(version: DefinitionVersion): Promise<Bundle | undefined> {
    try {
      return JSON.parse(await readFile(this.file(version.name, version.hash), 'utf8')).bundle
    } catch {
      return undefined
    }
  }

  // Reads a bundle the way a run would and says what it would be as a version;
  // `existing` is the published version with the same hash, if there is one.
  async prepare(
    name: string,
    bundle: Bundle,
    publisher: { iss: string; sub: string },
    // a proposal is read before anybody trusts it: it may not make the server fetch
    options: { noRemote?: boolean } = {}
  ): Promise<{ version: DefinitionVersion; existing?: DefinitionVersion }> {
    const hash = hashBundle(bundle)
    const existing = this.find(name, hash)
    if (existing) {
      return { version: existing, existing }
    }
    const { tasks, services, inputs, plan, accounts } = await planBundle(bundle, this.environment, {
      policy: this.options.policy,
      noRemote: options.noRemote,
    })
    return {
      version: {
        name,
        hash,
        entry: bundle.entry,
        publishedAt: new Date(this.now()).toISOString(),
        publishedBy: { iss: publisher.iss, sub: publisher.sub },
        tasks,
        services,
        inputs,
        plan,
        accounts,
      },
    }
  }

  // Publishing what already is there changes nothing and says so.
  async publish(
    name: string,
    bundle: Bundle,
    publisher: { iss: string; sub: string },
    approvedBy?: { iss: string; sub: string }
  ): Promise<{ version: DefinitionVersion; created: boolean }> {
    const prepared = await this.prepare(name, bundle, publisher)
    if (prepared.existing) {
      return { version: prepared.existing, created: false }
    }
    const version: DefinitionVersion = {
      ...prepared.version,
      publishedAt: new Date(this.now()).toISOString(),
      ...(approvedBy ? { approvedBy: { iss: approvedBy.iss, sub: approvedBy.sub } } : {}),
    }
    const file = this.file(name, version.hash)
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`
    await writeFile(temporary, JSON.stringify({ version, bundle }), { flag: 'wx' })
    await rename(temporary, file)
    this.add(version)
    return { version, created: true }
  }

  private has(name: string): boolean {
    return this.versions.has(name)
  }

  private add(version: DefinitionVersion): void {
    const versions = this.versions.get(version.name) ?? []
    versions.unshift(version)
    versions.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    this.versions.set(version.name, versions)
  }

  private file(name: string, hash: string): string {
    if (!HASH_PATTERN.test(hash)) {
      throw new DefinitionError('invalid hash')
    }
    return join(this.directory, name, `${hash.slice('sha256:'.length)}.json`)
  }
}
