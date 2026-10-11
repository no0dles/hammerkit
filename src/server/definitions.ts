import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'path'
import { randomBytes } from 'crypto'
import { parse } from 'yaml'
import { Environment } from '../executer/environment'
import { FileContext } from '../file/file-context'
import { getFileContext } from '../file/get-file-context'
import { isWithin } from '../includes/resolve-git-source'
import { createParseContext } from '../schema/schema-parser'
import { parseReferences } from '../schema/reference-parser'
import { getWorkContext } from '../schema/work-scope-parser'
import { isContainerWorkTask } from '../planner/work-task'
import { Bundle, hashBundle, HASH_PATTERN } from '../remote/bundle'
import { getErrorMessage } from '../log'

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
}

// The files a task reads and the tasks and services it waits for. Paths are
// relative to the root of the bundle, which is where the project's files go as
// well; what lies outside of it cannot be sent and is left out.
export interface DefinitionInputs {
  // the `src` patterns as the build file writes them (environment variables are
  // not substituted), `!` exclusions are kept
  src: string[]
  // host paths mounted into the container
  mounts: string[]
  deps: string[]
  needs: string[]
}

export interface InspectedBundle {
  tasks: string[]
  services: string[]
  inputs: Record<string, DefinitionInputs>
}

export class DefinitionError extends Error {}

// 40 (sha-1) or 64 (sha-256) hex digits
const COMMIT_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/i

// A hash alone can only name what is inside the bundle, so everything a build
// file pulls in from elsewhere has to be pinned: a git include needs a commit
// and a remote that is not a path on the server.
function findLooseIncludes(bundle: Bundle): string[] {
  const problems: string[] = []
  for (const [path, content] of Object.entries(bundle.files)) {
    if (!/\.ya?ml$/i.test(path)) {
      continue
    }
    let document: any
    try {
      document = parse(content)
    } catch {
      continue // a file that isn't valid yaml is reported when the bundle is parsed
    }
    for (const block of ['includes', 'references']) {
      for (const [name, include] of Object.entries(document?.[block] ?? {})) {
        const source = include as { git?: unknown; ref?: unknown }
        if (!source || typeof source !== 'object' || source.git === undefined) {
          continue
        }
        if (typeof source.git !== 'string' || !/^(https:\/\/|ssh:\/\/|git@[\w.-]+:)/.test(source.git)) {
          problems.push(`${path}: ${block}.${name}: git has to be an https:// or ssh:// address`)
        }
        if (typeof source.ref !== 'string' || !COMMIT_PATTERN.test(source.ref)) {
          problems.push(`${path}: ${block}.${name}: pin ref to a commit, a branch or tag can move`)
        }
      }
    }
  }
  return problems
}

// What a build file may read while it is inspected: its own files. The rest of
// the server is not its business (a missing file is "not there", not an error).
function confined(files: FileContext, root: string): FileContext {
  const check = (path: string) => {
    if (!isWithin(root, resolve(root, path))) {
      throw new DefinitionError(`${path} is outside of the bundle`)
    }
  }
  const guarded = (fn: (path: string) => any) => (path: string) => {
    check(path)
    return fn.call(files, path)
  }
  return {
    ...files,
    read: guarded(files.read),
    readStream: guarded(files.readStream),
    listFiles: guarded(files.listFiles),
    stats: guarded(files.stats),
    exists: async (path: string) => isWithin(root, resolve(root, path)) && files.exists(path),
    watch: files.watch,
  }
}

// A path of a task, written relative to the root of the bundle with forward
// slashes. A leading `!` (an exclusion) is kept. Nothing is returned for a path
// outside of the bundle.
function insideBundle(root: string, cwd: string, path: string): string[] {
  const negated = path.startsWith('!')
  const absolute = resolve(cwd, negated ? path.slice(1) : path)
  const inside = relative(root, absolute)
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    return []
  }
  const portable = inside.split(sep).join(posix.sep)
  // a pattern keeps its glob characters, `resolve` only normalizes separators
  return [`${negated ? '!' : ''}${portable === '' ? '.' : portable}`]
}

// Writes the bundle into a directory of its own and reads it the way a run
// would, so a build file that doesn't parse is refused when it is published, not
// when somebody wants to run it.
export async function inspectBundle(bundle: Bundle, environment: Environment): Promise<InspectedBundle> {
  const problems = findLooseIncludes(bundle)
  if (problems.length > 0) {
    throw new DefinitionError(problems.join('\n'))
  }
  const directory = await mkdtemp(join(tmpdir(), 'hammerkit-definition-'))
  try {
    for (const [path, content] of Object.entries(bundle.files)) {
      await mkdir(dirname(join(directory, path)), { recursive: true })
      await writeFile(join(directory, path), content)
    }
    const inspected: Environment = {
      ...environment,
      cwd: directory,
      file: confined(getFileContext(directory), directory),
    }
    try {
      const { ctx, scope } = await createParseContext(join(directory, bundle.entry), inspected)
      const context = await parseReferences(ctx, scope, inspected)
      const workTree = getWorkContext(context, { environmentName: null }, inspected)
      const inputs: Record<string, DefinitionInputs> = {}
      for (const item of Object.values(workTree.tasks)) {
        inputs[item.name] = {
          // the sources a task inherits from its dependencies belong to those
          src: item.data.src
            .filter((source) => source.inherited === null)
            .flatMap((source) => insideBundle(directory, item.data.cwd, source.source)),
          mounts: isContainerWorkTask(item.data)
            ? item.data.mounts.flatMap((mount) => insideBundle(directory, item.data.cwd, mount.localPath))
            : [],
          deps: item.deps.map((dep) => dep.name).sort(),
          needs: item.needs.map((need) => need.name).sort(),
        }
      }
      return {
        tasks: Object.keys(context.tasks).sort(),
        services: Object.keys(context.services).sort(),
        inputs: Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => (a < b ? -1 : 1))),
      }
    } catch (e) {
      throw new DefinitionError(getErrorMessage(e).split(directory).join('.'))
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

// The published build files: immutable versions, each named by its hash. They
// are kept in files, so a restart doesn't forget what runs were started from.
export class DefinitionStore {
  private readonly versions = new Map<string, DefinitionVersion[]>()

  constructor(
    private readonly directory: string,
    private readonly environment: Environment,
    private readonly now: () => number = Date.now
  ) {}

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

  // a hash, or `latest` for the version published last
  find(name: string, hash: string): DefinitionVersion | undefined {
    const versions = this.list(name)
    return hash === 'latest' ? versions[0] : versions.find((v) => v.hash === hash)
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
    publisher: { iss: string; sub: string }
  ): Promise<{ version: DefinitionVersion; existing?: DefinitionVersion }> {
    const hash = hashBundle(bundle)
    const existing = this.find(name, hash)
    if (existing) {
      return { version: existing, existing }
    }
    const { tasks, services, inputs } = await inspectBundle(bundle, this.environment)
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
