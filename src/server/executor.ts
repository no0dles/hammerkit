import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { isCheckRun } from './checks'
import { existsSync } from 'fs'
import { lstat, mkdir, rm, writeFile } from 'fs/promises'
import { dirname, join, relative, resolve, sep } from 'path'
import { createInterface } from 'readline'
import { isWithin } from '../includes/resolve-git-source'
import { SecretCatalog } from '../secrets/secret-catalog'
import { DefinitionStore } from './definitions'
import { checkoutRef, git } from './git-checkout'
import { RepoAccess } from './repo-access'
import { Run, RunContext, RunExecutor } from './runs'
import { PlanContext, planRun, refuseArguments } from './run-plan'
import { PlanPolicy } from './plan'
import { SandboxRegistry } from './sandboxes'
import { SandboxAttachment, SandboxClaim } from './sandbox-storage'
import { NetworkSchema } from '../schema/network-schema'
import { WorkerInput, WorkerMessage } from './run-worker'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { toNetworkSchema } from '../planner/work-network'

// `.git` as a file system may read it: any case, and a name Windows reads without its
// trailing dots and spaces, or by its short name
function isGitDirectory(segment: string): boolean {
  const name = segment.toLowerCase().replace(/[. ]+$/, '')
  return name === '.git' || name === 'git~1'
}

// A cancelled run gets this long to stop its tasks and remove its containers, after that
// its process is killed
const STOP_GRACE_MS = 15_000

// what is kept of the error output of a process that died without saying why
const MAX_STDERR = 2 * 1024

/**
 * The command that starts the process of a run: `hammerkit server-run`, from the
 * build this module is part of. Only found next to a built `index.js`.
 */
export function defaultWorker(): string[] | undefined {
  const entry = resolve(__dirname, '..', 'index.js')
  return existsSync(entry) ? [process.execPath, entry, 'server-run'] : undefined
}

export interface HostExecutorOptions {
  definitions: DefinitionStore
  // how build files are read: the environment of a run, the accounts of the operator
  planning: PlanContext
  // the repositories runs get their code from
  repos: RepoAccess
  // where the working directory of each run is made
  directory: string
  // where the task caches are kept, one directory below it per source trust
  cache: string
  // the command that starts the process of a run, see defaultWorker
  worker?: string[]
  // the sandboxes runs may work on, and what such a run may do
  sandboxes?: SandboxRunOptions
  // where container tasks run when not on this machine's docker daemon
  placement?: RunPlacement
  // the operator's log, which hears of a run directory that could not be removed
  log?: (line: string) => void
  // how long a cancelled run gets to stop before its process is killed
  stopGraceMs?: number
}

export interface SandboxRunOptions {
  registry: SandboxRegistry
  // the policy of a run on a sandbox: the runtimes of `sandboxes.runtimes`
  policy: PlanPolicy
  // the most open network a task or service of such a run gets
  network: NetworkSchema
}

/**
 * Where the container tasks and services of a run execute when it is not this
 * machine (see KubernetesExecutor): `prepare` before the process of the run starts,
 * which says the cluster and namespace and the variables the process needs to reach
 * it, and `release` when it ended, whatever the outcome.
 */
export interface RunPlacement {
  prepare(
    run: Run,
    context: RunContext,
    // where the run works, and the claim its tasks mount for it on a sandbox
    work?: { root: string; claim?: SandboxClaim }
  ): Promise<{ kubernetes: WorkKubernetesEnvironment; env: NodeJS.ProcessEnv }>
  release(run: Run, context: RunContext): Promise<void>
}

// The cache a run shares with others is the one of its source: the runs of a repository
// share one, those of an upload or a sandbox only their owner's. Somebody who can only
// upload, or an agent on a sandbox, can not leave an entry for a run from a reviewed
// repository to find.
//
// A check on a sandbox runs on a copy of the files a commit of them would hold, so it is a
// run of the repository like a ref run of that commit, and shares its cache: what its
// owner may write in the sandbox is not part of it.
export function cacheNamespace(run: Run): string {
  const repository = run.source.type === 'ref' || (run.source.type === 'sandbox' && run.source.check)
  const key = repository
    ? `ref\0${(run.source as { repo: string }).repo}`
    : `${run.source.type}\0${run.owner.iss}\0${run.owner.sub}`
  return `${repository ? 'ref' : run.source.type}-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`
}

// The docker volumes of a run's services are its caller's, within the cache's source trust:
// two callers of one repository share a cache, a task is keyed by what it reads, but not the
// data their services keep.
export function volumeScope(run: Run): string {
  const key = `${cacheNamespace(run)}\0${run.owner.iss}\0${run.owner.sub}`
  return `${run.source.type}-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`
}

/**
 * Runs the tasks of a run on this machine with the engine of `hammerkit run`, in a
 * process of its own.
 *
 * The working directory is made for the run and removed afterwards, or reported if it can
 * not be. Its build file is the published version the run is pinned to, written over the
 * code of the source, so the commands are the published ones whatever the source says. The process
 * starts with an environment the server builds: the variables `runs.env` lists, a home
 * directory that is the run's alone, and a cache directory per source trust. So what
 * the engine reads of its process (the docker host, the registry logins in the home
 * directory, the credentials of the operator) is what the operator gave runs and
 * nothing else. The cache is shared by the runs of the same source, a task is keyed by
 * its definition and sources and not by where they are.
 */
export class HostExecutor implements RunExecutor {
  constructor(private readonly options: HostExecutorOptions) {}

  async execute(run: Run, context: RunContext): Promise<void> {
    const { definitions, planning, repos } = this.options
    const version = definitions.find(run.definition)
    const bundle = version ? await definitions.files(version) : undefined
    if (!version || !bundle) {
      throw new Error(`the build file ${run.definition} is no longer on this server`)
    }
    // pulled back after the run was accepted, while it waited for an approval or in the queue
    if (version.yanked) {
      throw new Error(
        `the build file ${run.definition} was yanked${version.yanked.reason ? `: ${version.yanked.reason}` : ''}`
      )
    }
    if (run.source.type === 'upload') {
      throw new Error('runs from an upload are not supported by this server yet, use a git ref')
    }
    const source = run.source
    const sandboxes = this.options.sandboxes
    if (source.type === 'sandbox' && !sandboxes) {
      throw new Error('this server keeps no sandboxes')
    }
    if (source.type === 'ref' && !repos.readable(source.repo)) {
      throw new Error(`this server can not read ${source.repo}, the operator lists it in sources`)
    }
    const worker = this.options.worker ?? defaultWorker()
    if (!worker) {
      throw new Error('this server has no command to start a run with, it needs to run from a built hammerkit')
    }

    // what was approved is what runs: the accounts are read again from the files with
    // the environment of the run, and the run may use no more than it was admitted for
    const policy = source.type === 'sandbox' && sandboxes ? sandboxes.policy : planning.policy
    const planned = await planRun(bundle, run, planning.environment, policy)
    const extra = planned.accounts.filter((account) => !run.accounts.includes(account))
    if (extra.length > 0) {
      throw new Error(`the run would use ${extra.join(', ')}, which it was not admitted for`)
    }
    const refused = refuseArguments(run, planned.plan, policy)
    if (refused) {
      throw new Error(refused)
    }

    const abortCtrl = new AbortController()
    const abort = () => abortCtrl.abort()
    if (context.signal.aborted) {
      abort()
    }
    context.signal.addEventListener('abort', abort, { once: true })

    const root = join(this.options.directory, run.id)
    let attachment: SandboxAttachment | undefined
    try {
      // where the process of the run starts: the checkout of a ref, or for a sandbox the
      // published files, so what the process and the secret providers it starts read of
      // their directory is never what a task wrote
      let cwd: string
      let input: Pick<WorkerInput, 'entry' | 'directory' | 'network' | 'sandboxNetwork'>
      let claim: SandboxClaim | undefined
      // the files of the sandbox the tasks work on
      let work: string | undefined
      if (source.type === 'sandbox' && source.check) {
        // a check works on the files a push of the sandbox commits, copied out of it: never
        // on the sandbox, whose ignored files (node_modules, outputs) its owner writes
        const { registry, network } = sandboxes as SandboxRunOptions
        cwd = join(root, 'source')
        try {
          await registry.exportTree(source.id, source.tree, cwd, abortCtrl.signal)
        } catch (e) {
          throw new Error(
            `the files of the sandbox ${source.id} could not be copied for the check, submit it again: ${
              e instanceof Error ? e.message : String(e)
            }`
          )
        }
        // a repository of its own, as a checkout of the commit is: the root of the project,
        // which the paths of the tasks' keys are relative to, is the one of git
        await git(['init', '--quiet', cwd], {}, abortCtrl.signal, `the check of sandbox ${source.id}`, 'init')
        context.emit({
          type: 'log',
          task: 'hammerkit',
          stream: 'stdout',
          text: `check of sandbox ${source.id} of ${source.repo}: files ${source.tree}, fetched at ${source.commit}`,
        })
        await this.writeBundle(cwd, bundle.files)
        input = {
          entry: join(cwd, version.entry),
          ...(planning.policy.network ? { network: toNetworkSchema(planning.policy.network) } : {}),
          sandboxNetwork: network,
        }
      } else if (source.type === 'ref') {
        cwd = join(root, 'source')
        const { repo, ref, commit: pinned } = source
        const credentials = await repos.credentials(repo)
        let commit: string
        try {
          commit = await checkoutRef(repos.url(repo), ref, cwd, credentials.env, abortCtrl.signal, pinned)
        } catch (e) {
          throw repos.scrub(e, credentials.values)
        }
        context.emit({ type: 'log', task: 'hammerkit', stream: 'stdout', text: `checked out ${repo} at ${commit}` })
        await this.writeBundle(cwd, bundle.files)
        // what the version was checked against at publish holds while it runs too
        input = {
          entry: join(cwd, version.entry),
          ...(planning.policy.network ? { network: toNetworkSchema(planning.policy.network) } : {}),
        }
      } else {
        // the published files are read from a directory of the run and work on the
        // sandbox, whose own build files are just files
        const { registry, network } = sandboxes as SandboxRunOptions
        // read before the run attaches: until then the walk of the last run's measure holds
        const state = await registry.state(source.id, abortCtrl.signal)
        attachment = await registry.attach(source.id, join(root, 'sandbox'))
        work = attachment.directory
        claim = attachment.claim
        // what was approved is what runs: the files may have changed since, by a run
        // before this one on the sandbox
        if (run.approvals?.length && state.tree !== source.tree) {
          throw new Error(
            `the files of the sandbox ${source.id} changed since the run was approved, they are ${state.tree} now and were ${source.tree}, submit the run again`
          )
        }
        if (claim && !this.options.placement) {
          throw new Error(`the sandbox ${source.id} is a claim on a cluster, this server runs tasks on its own docker`)
        }
        context.emit({
          type: 'log',
          task: 'hammerkit',
          stream: 'stdout',
          text: `sandbox ${source.id} of ${source.repo} at ${state.commit}, files ${state.tree}${
            state.clean ? '' : ' with changes'
          }`,
        })
        const published = join(root, 'bundle')
        await mkdir(published, { recursive: true })
        await this.writeBundle(published, bundle.files)
        cwd = published
        input = {
          entry: join(published, version.entry),
          directory: { read: published, work },
          // the worker takes the lower of sandboxes.network and runs.network
          ...(planning.policy.network ? { network: toNetworkSchema(planning.policy.network) } : {}),
          sandboxNetwork: network,
        }
      }

      const home = join(root, 'home')
      await mkdir(home, { recursive: true })
      const cache = join(this.options.cache, cacheNamespace(run))
      await mkdir(cache, { recursive: true })
      const placement = this.options.placement
      const placed = placement ? await placement.prepare(run, context, { root: work ?? cwd, claim }) : undefined
      try {
        await this.runInProcess(
          worker,
          {
            ...input,
            tasks: run.tasks,
            options: run.options,
            accounts: run.accounts,
            volumeScope: volumeScope(run),
            ...(isCheckRun(run) ? { check: true } : {}),
            catalog: planning.environment.hosted?.catalog as SecretCatalog,
            ...(placed ? { kubernetes: placed.kubernetes } : {}),
          },
          cwd,
          { ...this.processEnvironment(home, cache), ...placed?.env },
          context,
          abortCtrl.signal
        )
      } finally {
        if (placement && placed) {
          await placement.release(run, context)
        }
      }
    } finally {
      context.signal.removeEventListener('abort', abort)
      attachment?.release?.()
      await this.removeRunDirectory(run, root, context)
      if (source.type === 'sandbox') {
        // what the run wrote counts against the owner's limits, from their next run or create
        sandboxes?.registry.measure(source.id).catch(() => undefined)
      }
    }
  }

  // A task of the run may still hold a file of its directory for a moment after the run
  // ended, which Windows refuses to remove. A directory that stays is reported, to the run
  // by its error code and to the operator with its path; it does not change how the run ended.
  private async removeRunDirectory(run: Run, root: string, context: RunContext): Promise<void> {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (e) {
      const error = e as NodeJS.ErrnoException
      context.emit({
        type: 'log',
        task: 'hammerkit',
        stream: 'stderr',
        text: `the working directory of the run could not be removed: ${error.code ?? 'unknown error'}`,
      })
      this.options.log?.(`run=${run.id} could not remove its directory: ${error.message}`)
    }
  }

  // What the process of a run sees: the variables the operator listed, and a home
  // directory and cache that are the run's. The server's own are not in it.
  private processEnvironment(home: string, cache: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(this.options.planning.environment.processEnvs)) {
      if (value !== undefined) {
        env[key] = value
      }
    }
    env.HOME = home
    env.USERPROFILE = home
    env.APPDATA = join(home, 'AppData', 'Roaming')
    env.LOCALAPPDATA = join(home, 'AppData', 'Local')
    env.HAMMERKIT_DIR = cache
    return env
  }

  // Starts the process, hands it the run on its standard input and relays what it reports.
  // A cancelled run is told so on the standard input, the same on every platform, so the
  // engine stops its tasks and removes its containers; a signal on Windows would end the
  // process at once and leave its tasks running in the directory of the run. The process is
  // killed if it has not stopped after the grace period.
  private runInProcess(
    command: string[],
    input: WorkerInput,
    cwd: string,
    env: NodeJS.ProcessEnv,
    context: RunContext,
    signal: AbortSignal
  ): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command[0], command.slice(1), {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      child.stdin.on('error', () => undefined)
      // the run first, so a cancel comes after it; kept open, it is how a cancel reaches the process
      child.stdin.write(`${JSON.stringify(input)}\n`)
      let result: Extract<WorkerMessage, { kind: 'result' }> | undefined
      let stderr = ''
      let killTimer: NodeJS.Timeout | undefined
      const stop = () => {
        child.stdin.write('cancel\n', (e) => {
          if (e) {
            child.kill()
          }
        })
        killTimer = setTimeout(() => child.kill('SIGKILL'), this.options.stopGraceMs ?? STOP_GRACE_MS)
        killTimer.unref()
      }
      if (signal.aborted) {
        stop()
      } else {
        signal.addEventListener('abort', stop, { once: true })
      }

      createInterface({ input: child.stdout }).on('line', (line) => {
        try {
          const message = JSON.parse(line) as WorkerMessage
          if (message.kind === 'event') {
            context.emit(message.event)
          } else if (message.kind === 'result') {
            result = message
            // nothing left to tell the process
            child.stdin.end()
          }
        } catch {
          // not ours: whatever else the process prints is not an event of the run
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR)
      })
      child.on('error', (e) => {
        signal.removeEventListener('abort', stop)
        clearTimeout(killTimer)
        reject(new Error(`the process of the run could not start: ${e.message}`))
      })
      child.on('close', (code, killed) => {
        signal.removeEventListener('abort', stop)
        clearTimeout(killTimer)
        if (result?.ok) {
          resolvePromise()
        } else if (result) {
          reject(new Error(result.error ?? 'the run failed'))
        } else if (signal.aborted) {
          reject(new Error('the run was cancelled'))
        } else {
          const reason = stderr.trim().split('\n').pop() ?? ''
          reject(
            new Error(
              `the process of the run stopped (${killed ? `signal ${killed}` : `code ${code}`})${
                reason ? `: ${reason}` : ''
              }`
            )
          )
        }
      })
    })
  }

  // The published files go over the checkout; nothing may land outside of it or in
  // its git directory. The checkout is somebody else's: it may hold a symbolic link where
  // a directory or a file of the bundle goes, which would carry the write out of it, so
  // none is followed. `.git` is compared the way a case-insensitive or Windows file system
  // would read it.
  private async writeBundle(directory: string, files: { [path: string]: string }): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
      const target = resolve(directory, path)
      const refused = () => new Error(`the published file ${JSON.stringify(path)} can not be written into the source`)
      if (!isWithin(directory, target) || path.split(/[\\/]/).some((part) => isGitDirectory(part))) {
        throw refused()
      }
      const parts = relative(directory, target).split(sep)
      let current = directory
      for (const [index, part] of parts.entries()) {
        current = join(current, part)
        const stats = await lstat(current).catch(() => undefined)
        if (!stats) {
          break
        }
        if (stats.isSymbolicLink() || (index < parts.length - 1 && !stats.isDirectory())) {
          throw refused()
        }
      }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content)
    }
  }
}
