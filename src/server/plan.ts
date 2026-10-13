import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'path'
import { parse } from 'yaml'
import { Environment } from '../executer/environment'
import { FileContext } from '../file/file-context'
import { getFileContext } from '../file/get-file-context'
import { isWithin } from '../includes/resolve-git-source'
import { createParseContext } from '../schema/schema-parser'
import { parseReferences } from '../schema/reference-parser'
import { getWorkContext } from '../schema/work-scope-parser'
import { WorkScope } from '../executer/work-scope'
import { WorkTree } from '../planner/work-tree'
import { WorkSecret } from '../planner/work-secret'
import { isContainerWorkTask, isWorkTask } from '../planner/work-task'
import { isContainerWorkService, WorkService } from '../planner/work-service'
import { WorkTask } from '../planner/work-task'
import { Bundle } from '../remote/bundle'
import { getErrorMessage } from '../log'
import { ParseError } from '../schema/parse-error'
import { NetworkSchema } from '../schema/network-schema'
import { getArgumentsTarget } from '../planner/utils/task-arguments'
import { exceedsNetwork, formatNetwork, isLimitedNetwork, toNetworkSchema, WorkNetwork } from '../planner/work-network'

export class DefinitionError extends Error {}

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

// What a task or service does, for the person who decides about it: derived from
// the published files and stored with the version, so it is what the hash vouches
// for. Values of secrets are never in it, only where they come from.
export interface TaskPlan {
  kind: 'task' | 'service'
  runtime: 'docker' | 'local'
  image?: string
  cmds: string[]
  // where arguments land: the last command of a task, the `cmd` of a service;
  // null when there is none. Versions published before this was recorded have none.
  command?: string | null
  // what it reaches besides its needs, as the build file declares it (local tasks: open)
  network?: NetworkSchema
  deps: string[]
  needs: string[]
  // the accounts its secrets are read as
  accounts: string[]
  secrets: { from: string; account: string | null; target: string }[]
  // the variables of the server its `envs` read (`$NAME`, `${NAME}`); versions
  // published before this was recorded have none
  serverEnvs?: string[]
  mounts: string[]
  ports: string[]
  generates: string[]
  // what a reviewer looks at first
  flags: ('local-task' | 'host-port' | 'remote-include')[]
}

export interface InspectedBundle {
  tasks: string[]
  services: string[]
  inputs: Record<string, DefinitionInputs>
  plan: Record<string, TaskPlan>
  // every account any of the tasks and services uses
  accounts: string[]
}

export interface PlanPolicy {
  // the variables of the server an `env:NAME` secret may read
  envs: string[]
  // where the operator lists them, for the message; `runs.env.allow` when left out
  envsFrom?: string
  // the accounts that only the server uses, such as the one that reads repositories
  reserved?: string[]
  // what tasks may run on; every runtime when left out
  runtimes?: ('docker' | 'local')[]
  // the most any task or service may reach besides its needs (`runs.network`);
  // open when left out
  network?: WorkNetwork
  // where tasks run: on a cluster, the secrets of providers are read in the Job of a task
  backend?: 'host' | 'kubernetes'
}

export interface PlanOptions {
  // what is planned: the whole build file when left out, else what a run executes
  // (the named tasks or labels with their dependencies, services and init tasks)
  scope?: WorkScope
  // set on a server
  policy?: PlanPolicy
  // refuse git includes: reading them would make the machine fetch from the network
  noRemote?: boolean
}

// 40 (sha-1) or 64 (sha-256) hex digits
const COMMIT_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/i

// A hash alone can only name what is inside the bundle, so everything a build
// file pulls in from elsewhere has to be pinned: a git include needs a commit
// and a remote that is not a path on the server.
function findLooseIncludes(bundle: Bundle, noRemote = false): string[] {
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
        if (noRemote) {
          problems.push(
            `${path}: ${block}.${name}: a proposal may not include from git, the server would fetch it before anybody approved it`
          )
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

// What a build file may not name on a server: the places it would run or store things
// are the operator's. The docker host, a Kubernetes cluster and a remote cache are
// credentials of the machine, not of the build file, and a project file that could carry
// them could send runs, or the cache, anywhere.
function findHostProblems(bundle: Bundle): string[] {
  const problems: string[] = []
  for (const [path, content] of Object.entries(bundle.files)) {
    if (!/\.ya?ml$/i.test(path)) {
      continue
    }
    let document: any
    try {
      document = parse(content)
    } catch {
      continue // reported when the bundle is parsed
    }
    if (!document || typeof document !== 'object') {
      continue
    }
    if (document.environments && Object.keys(document.environments).length > 0) {
      problems.push(
        `${path}: environments pick a docker host or a Kubernetes cluster, which are the server's to choose, remove them`
      )
    }
    for (const [name, cache] of Object.entries<any>(document.caches ?? {})) {
      if (cache?.backend?.type !== 'local' || cache.backend.path !== undefined) {
        problems.push(`${path}: caches.${name}: a server keeps its own cache, a build file names no backend or path`)
      }
    }
    for (const [name, service] of Object.entries<any>(document.services ?? {})) {
      if (
        service &&
        typeof service === 'object' &&
        ('selector' in service || 'kubeconfig' in service || 'context' in service)
      ) {
        problems.push(`${path}: services.${name}: Kubernetes services are not supported on a server`)
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

type Item = { name: string; data: WorkTask | WorkService; deps: { name: string }[]; needs: { name: string }[] }

function itemsOf(workTree: WorkTree): Item[] {
  return [...Object.values(workTree.tasks), ...Object.values(workTree.services)]
}

function secretsOf(item: Item): WorkSecret[] {
  return 'secrets' in item.data ? item.data.secrets : []
}

function describeSecret(secret: WorkSecret): { from: string; account: string | null; target: string } {
  const target = secret.target.type === 'env' ? secret.target.name : secret.target.path
  const source = secret.source
  if (source.type === 'provider') {
    return { from: `${source.provider}:${source.ref}`, account: source.account, target }
  }
  return { from: source.type === 'env' ? `env:${source.name}` : `file:${source.path}`, account: null, target }
}

// What a server refuses to publish. A secret that reads a file or a variable of the
// server has no account, so nothing would stand between the build file and the
// operator's own credentials.
function findPolicyProblems(items: Item[], policy: PlanPolicy, root: string): string[] {
  const problems: string[] = []
  for (const item of items) {
    const runtime = item.data.type === 'local-task' ? 'local' : 'docker'
    if (policy.runtimes && !policy.runtimes.includes(runtime)) {
      problems.push(
        `${
          item.name
        }: runs on the ${runtime} runtime, which this server does not allow (runtimes: ${policy.runtimes.join(', ')})`
      )
    }
    const data = item.data
    const ceiling = policy.network
    if (ceiling && isLimitedNetwork(ceiling)) {
      if (data.type === 'local-task') {
        problems.push(
          `${
            item.name
          }: is a local task, which can't be limited to the network this server allows (runs.network: ${formatNetwork(
            ceiling
          )})`
        )
      } else if ('network' in data && exceedsNetwork(data.network, ceiling)) {
        problems.push(
          `${item.name}: asks for network ${formatNetwork(
            data.network
          )}, more than this server allows (runs.network: ${formatNetwork(ceiling)})`
        )
      }
    }
    // what a task reads and writes is the bundle's: `src: ../..` would have the server
    // copy its own files (its credentials, other callers' caches) into the task
    for (const source of 'src' in data ? data.src : []) {
      if (!source.inherited && insideBundle(root, data.cwd, source.absolutePath).length === 0) {
        problems.push(`${item.name}: src ${source.source} is outside of the bundle`)
      }
    }
    for (const generate of isWorkTask(data) ? data.generates : []) {
      if (!generate.inherited && insideBundle(root, data.cwd, generate.path).length === 0) {
        problems.push(`${item.name}: generates ${generate.path}, which is outside of the bundle`)
      }
    }
    if (isContainerWorkTask(data) || isContainerWorkService(data)) {
      for (const mount of data.mounts) {
        // a path of the server is not the build file's to mount: the docker socket, /etc, a home directory
        if (insideBundle(root, data.cwd, mount.localPath).length === 0) {
          problems.push(`${item.name}: mounts ${mount.localPath}, which is outside of the bundle`)
        }
      }
    }
    for (const secret of secretsOf(item)) {
      const source = secret.source
      if (policy.backend === 'kubernetes' && source.type === 'provider') {
        // the server reads no secret of a provider on a cluster: the Job of a task does
        if (!isWorkTask(item.data)) {
          problems.push(
            `${item.name}: the secret ${describeSecret(secret).target} is read from ${source.provider}, which ` +
              'this server does for tasks only, a service on its cluster gets no provider secret yet'
          )
        } else if (secret.cache) {
          problems.push(
            `${item.name}: the secret ${describeSecret(secret).target} has cache: true, its digest would need ` +
              'the value before the Job of the task reads it, which this server does not support yet'
          )
        } else if (item.data.network.type !== 'open') {
          // the init containers that read it share the pod's NetworkPolicy
          problems.push(
            `${item.name}: the secret ${describeSecret(secret).target} is read from ${source.provider} in the ` +
              `Job of the task, which network ${formatNetwork(item.data.network)} would cut off from it, ` +
              'a task that reads secrets of a provider keeps an open network on this server'
          )
        }
      }
      if (source.type === 'provider' && policy.reserved?.includes(source.account)) {
        problems.push(
          `${item.name}: the secret ${describeSecret(secret).target} is read as ${
            source.account
          }, which the server uses to read repositories`
        )
      } else if (source.type === 'file') {
        problems.push(`${item.name}: a secret can not read a file of the server (file:), use a secret provider`)
      } else if (source.type === 'env' && !policy.envs.includes(source.name)) {
        problems.push(
          `${item.name}: the secret ${describeSecret(secret).target} reads env:${
            source.name
          }, which the server does not list in ${policy.envsFrom ?? 'runs.env.allow'}`
        )
      }
    }
  }
  return problems
}

function toPlan(root: string, item: Item): TaskPlan {
  const data = item.data
  const secrets = secretsOf(item).map(describeSecret)
  const accounts = [...new Set(secrets.flatMap((secret) => (secret.account ? [secret.account] : [])))].sort()
  const mounts =
    isContainerWorkTask(data) || isContainerWorkService(data)
      ? data.mounts.map((mount) => {
          const inside = insideBundle(root, data.cwd, mount.localPath)
          return `${inside.length > 0 ? inside[0] : mount.localPath}:${mount.containerPath}${
            mount.readOnly ? ':ro' : ''
          }`
        })
      : []
  const ports = 'ports' in data ? data.ports.map((port) => `${port.hostPort ?? ''}:${port.containerPort}`) : []
  const flags: TaskPlan['flags'] = []
  if (data.type === 'local-task') {
    flags.push('local-task')
  }
  if ('ports' in data && data.ports.some((port) => port.hostPort !== null)) {
    flags.push('host-port')
  }
  if (data.scope.remote) {
    flags.push('remote-include')
  }
  const isTask = data.type === 'local-task' || data.type === 'container-task'
  return {
    kind: isTask ? 'task' : 'service',
    runtime: data.type === 'local-task' ? 'local' : 'docker',
    ...(isContainerWorkTask(data) || isContainerWorkService(data) ? { image: data.image } : {}),
    cmds: 'cmds' in data ? data.cmds.map((cmd) => cmd.cmd) : 'cmd' in data && data.cmd ? [data.cmd.cmd] : [],
    command: getArgumentsTarget(data)?.cmd ?? null,
    network: toNetworkSchema('network' in data ? data.network : { type: 'open' }),
    deps: item.deps.map((dep) => dep.name).sort(),
    needs: item.needs.map((need) => need.name).sort(),
    accounts,
    secrets,
    serverEnvs: 'envs' in data ? data.envs.processNames ?? [] : [],
    mounts,
    ports,
    generates: 'generates' in data ? data.generates.map((generate) => generate.path) : [],
    flags,
  }
}

// A file that does not match the schema says where, not only that it does not.
function describeFailure(e: unknown): string {
  if (e instanceof ParseError) {
    const issue = e.zod.issues[0]
    return `${e.buildFilePath}: ${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}`
  }
  return getErrorMessage(e)
}

// Writes the bundle into a directory of its own and reads it the way a run
// would, so a build file that doesn't parse is refused when it is published, not
// when somebody wants to run it. The same function answers what a run will do,
// with the scope of the run: which tasks, services and accounts it involves.
export async function planBundle(
  bundle: Bundle,
  environment: Environment,
  options: PlanOptions = {}
): Promise<InspectedBundle> {
  const problems = [...findLooseIncludes(bundle, options.noRemote), ...(options.policy ? findHostProblems(bundle) : [])]
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
      const workTree = getWorkContext(context, options.scope ?? { environmentName: null }, inspected)
      const items = itemsOf(workTree)
      if (options.policy) {
        const policyProblems = findPolicyProblems(items, options.policy, directory)
        if (policyProblems.length > 0) {
          throw new DefinitionError(policyProblems.join('\n'))
        }
      }
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
      const plan: Record<string, TaskPlan> = {}
      for (const item of items) {
        plan[item.name] = toPlan(directory, item)
      }
      const sorted = <T>(record: Record<string, T>) =>
        Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)))
      return {
        tasks: Object.keys(context.tasks).sort(),
        services: Object.keys(context.services).sort(),
        inputs: sorted(inputs),
        plan: sorted(plan),
        accounts: [...new Set(Object.values(plan).flatMap((entry) => entry.accounts))].sort(),
      }
    } catch (e) {
      throw new DefinitionError(describeFailure(e).split(directory).join('.'))
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

// Reads a bundle the way a run would; see planBundle.
export const inspectBundle = (bundle: Bundle, environment: Environment): Promise<InspectedBundle> =>
  planBundle(bundle, environment)
