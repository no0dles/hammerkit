import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { lstat, mkdir, rm, writeFile } from 'fs/promises'
import { dirname, join, relative, resolve, sep } from 'path'
import { createInterface } from 'readline'
import { isWithin } from '../includes/resolve-git-source'
import { SecretCatalog } from '../secrets/secret-catalog'
import { DefinitionStore } from './definitions'
import { checkoutRef } from './git-checkout'
import { RepoAccess } from './repo-access'
import { Run, RunContext, RunExecutor } from './runs'
import { PlanContext, planRun } from './run-plan'
import { WorkerInput, WorkerMessage } from './run-worker'

// `.git` as a file system may read it: any case, and a name Windows reads without its
// trailing dots and spaces, or by its short name
function isGitDirectory(segment: string): boolean {
  const name = segment.toLowerCase().replace(/[. ]+$/, '')
  return name === '.git' || name === 'git~1'
}

// A cancelled run gets this long to stop its tasks and remove its containers
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
}

// The cache a run shares with others is the one of its source: the runs of a repository
// share one, those of an upload only the uploader's. Somebody who can only upload can
// not leave an entry for a run from a reviewed repository to find.
function cacheNamespace(run: Run): string {
  const key = run.source.type === 'ref' ? `ref\0${run.source.repo}` : `upload\0${run.owner.iss}\0${run.owner.sub}`
  return `${run.source.type}-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`
}

/**
 * Runs the tasks of a run on this machine with the engine of `hammerkit run`, in a
 * process of its own.
 *
 * The working directory is made for the run and removed afterwards. Its build
 * file is the published version the run is pinned to, written over the code of the
 * source, so the commands are the published ones whatever the source says. The process
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
    if (run.source.type !== 'ref') {
      throw new Error('runs from an upload are not supported by this server yet, use a git ref')
    }
    const { repo, ref, commit: pinned } = run.source
    if (!repos.readable(repo)) {
      throw new Error(`this server can not read ${repo}, the operator lists it in sources`)
    }
    const worker = this.options.worker ?? defaultWorker()
    if (!worker) {
      throw new Error('this server has no command to start a run with, it needs to run from a built hammerkit')
    }

    // what was approved is what runs: the accounts are read again from the files with
    // the environment of the run, and the run may use no more than it was admitted for
    const planned = await planRun(bundle, run, planning.environment, planning.policy)
    const extra = planned.accounts.filter((account) => !run.accounts.includes(account))
    if (extra.length > 0) {
      throw new Error(`the run would use ${extra.join(', ')}, which it was not admitted for`)
    }

    const abortCtrl = new AbortController()
    const abort = () => abortCtrl.abort()
    if (context.signal.aborted) {
      abort()
    }
    context.signal.addEventListener('abort', abort, { once: true })

    const root = join(this.options.directory, run.id)
    const checkout = join(root, 'source')
    try {
      const credentials = await repos.credentials(repo)
      let commit: string
      try {
        commit = await checkoutRef(repos.url(repo), ref, checkout, credentials.env, abortCtrl.signal, pinned)
      } catch (e) {
        throw repos.scrub(e, credentials.values)
      }
      context.emit({ type: 'log', task: 'hammerkit', stream: 'stdout', text: `checked out ${repo} at ${commit}` })
      await this.writeBundle(checkout, bundle.files)

      const home = join(root, 'home')
      await mkdir(home, { recursive: true })
      const cache = join(this.options.cache, cacheNamespace(run))
      await mkdir(cache, { recursive: true })
      const input: WorkerInput = {
        entry: join(checkout, version.entry),
        tasks: run.tasks,
        options: run.options,
        accounts: run.accounts,
        catalog: planning.environment.hosted?.catalog as SecretCatalog,
      }
      await this.runInProcess(worker, input, checkout, this.processEnvironment(home, cache), context, abortCtrl.signal)
    } finally {
      context.signal.removeEventListener('abort', abort)
      await rm(root, { recursive: true, force: true })
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

  // Starts the process, hands it the run on its standard input and relays what it reports. It
  // is stopped with SIGTERM when the run is cancelled, so the engine removes its containers
  // and stops its tasks, and killed if it does not stop in time.
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
      let result: Extract<WorkerMessage, { kind: 'result' }> | undefined
      let stderr = ''
      let killTimer: NodeJS.Timeout | undefined
      const stop = () => {
        child.kill('SIGTERM')
        killTimer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS)
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
          }
        } catch {
          // not ours: whatever else the process prints is not an event of the run
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR)
      })
      child.stdin.on('error', () => undefined)
      child.stdin.end(JSON.stringify(input))
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
