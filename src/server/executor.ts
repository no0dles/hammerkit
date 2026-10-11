import { mkdir, rm, writeFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { Environment, HostedPolicy } from '../executer/environment'
import { CliExecOptions, getCli } from '../cli'
import { getFileContext } from '../file/get-file-context'
import { consoleContext } from '../log'
import { isWithin } from '../includes/resolve-git-source'
import { createParseContext } from '../schema/schema-parser'
import { parseReferences } from '../schema/reference-parser'
import { getWorkContext } from '../schema/work-scope-parser'
import { statusConsole } from '../planner/work-item-status'
import { iterateWorkTasks } from '../planner/utils/plan-work-tasks'
import { createSecretRegistry, SecretRegistry } from '../utils/redact'
import { SecretCatalog } from '../secrets/secret-catalog'
import { emptyWritable } from '../utils/empty-writable'
import { parseDuration } from '../utils/units'
import { DefinitionStore } from './definitions'
import { checkoutRef } from './git-checkout'
import { RepoAccess } from './repo-access'
import { Run, RunContext, RunExecutor } from './runs'
import { ServerConfig } from './server-config'
import { getRunScopes, PlanContext, planRun } from './run-plan'

// one log line of a task is cut here, the registry caps how many events a run keeps
const MAX_LOG_TEXT = 8 * 1024

export interface HostExecutorOptions {
  config: ServerConfig
  definitions: DefinitionStore
  // the server's own environment: where it runs
  environment: Environment
  // how build files are read: the environment of a run, the accounts of the operator
  planning: PlanContext
  // the repositories runs get their code from
  repos: RepoAccess
  // where the working directory of each run is made
  directory: string
}

/**
 * Runs the tasks of a run on this machine with the engine of `hammerkit run`.
 *
 * The working directory is made for the run and removed afterwards. Its build
 * file is the published version the run is pinned to, written over the code of the
 * source, so the commands are the published ones whatever the source says. The
 * local cache is shared by all runs, a task is keyed by its definition and
 * sources and not by where they are.
 */
export class HostExecutor implements RunExecutor {
  constructor(private readonly options: HostExecutorOptions) {}

  async execute(run: Run, context: RunContext): Promise<void> {
    const { definitions, planning, repos } = this.options
    const version = definitions.find(run.definition.name, run.definition.hash)
    const bundle = version ? await definitions.files(version) : undefined
    if (!version || !bundle) {
      throw new Error(`the build file ${run.definition.name} at ${run.definition.hash} is no longer on this server`)
    }
    if (run.source.type !== 'ref') {
      throw new Error('runs from an upload are not supported by this server yet, use a git ref')
    }
    const { repo, ref, commit: pinned } = run.source
    if (!repos.readable(repo)) {
      throw new Error(`this server can not read ${repo}, the operator lists it in sources`)
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

    const secrets = createSecretRegistry()
    const root = join(this.options.directory, run.id)
    const checkout = join(root, 'source')
    try {
      const passed = planning.environment.processEnvs
      // the token of the repository is masked in all this run logs, and reaches git only
      const credentials = await repos.credentials(repo)
      credentials.values.forEach((value) => secrets.register(value))
      let commit: string
      try {
        commit = await checkoutRef(repos.url(repo), ref, checkout, credentials.env, abortCtrl.signal, pinned)
      } catch (e) {
        throw repos.scrub(e, credentials.values)
      }
      context.emit({ type: 'log', task: 'hammerkit', stream: 'stdout', text: `checked out ${repo} at ${commit}` })
      await this.writeBundle(checkout, bundle.files)
      await this.runTasks(
        run,
        context,
        secrets,
        join(checkout, version.entry),
        checkout,
        passed,
        { catalog: planning.environment.hosted?.catalog as SecretCatalog, accounts: run.accounts },
        abortCtrl
      )
    } finally {
      context.signal.removeEventListener('abort', abort)
      await rm(root, { recursive: true, force: true })
    }
  }

  // The published files go over the checkout; nothing may land outside of it or in
  // its git directory.
  private async writeBundle(directory: string, files: { [path: string]: string }): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
      const target = resolve(directory, path)
      if (!isWithin(directory, target) || /^\.git(\/|$)/.test(path)) {
        throw new Error(`the published file ${JSON.stringify(path)} can not be written into the source`)
      }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content)
    }
  }

  private async runTasks(
    run: Run,
    context: RunContext,
    secrets: SecretRegistry,
    entry: string,
    cwd: string,
    passed: { [key: string]: string | undefined },
    hosted: HostedPolicy,
    abortCtrl: AbortController
  ): Promise<void> {
    const status = statusConsole(emptyWritable(), secrets)
    // what the engine would print to a terminal is not wanted, its status console
    // is what is streamed: it is redacted with the secrets of this run
    const environment: Environment = {
      processEnvs: passed,
      hosted,
      abortCtrl,
      cwd,
      file: getFileContext(cwd),
      console: consoleContext(emptyWritable()),
      status,
      secrets,
      stdout: emptyWritable(),
      stderr: emptyWritable(),
      stdoutColumns: 120,
    }
    const listener = status.on((message) => {
      if (message.type === 'console') {
        context.emit({
          type: 'log',
          task: message.context.name,
          stream: message.console,
          text: message.message.slice(0, MAX_LOG_TEXT),
        })
      } else if (message.level === 'error' || message.level === 'warn') {
        context.emit({
          type: 'log',
          task: message.context.name,
          stream: 'stderr',
          text: message.message.slice(0, MAX_LOG_TEXT),
        })
      }
    })

    try {
      const options = run.options
      const execOptions: Partial<CliExecOptions> = {
        logMode: 'live',
        cacheDefault: options.cache ?? 'checksum',
        cacheReadOnly: options.cacheReadOnly ?? false,
        timeout: options.timeout ? parseDuration(options.timeout) : null,
        skipDeps: options.skipDeps !== false,
      }
      const scopes = getRunScopes(run.tasks, options)

      for (const { name, scope } of scopes) {
        const { ctx, scope: parsed } = await createParseContext(entry, environment)
        const workTree = getWorkContext(await parseReferences(ctx, parsed, environment), scope, environment)
        const cli = getCli(workTree, environment)
        if (cli.tasks().length === 0) {
          throw new Error(`no tasks found for ${name}`)
        }
        const execution = cli.exec({ ...execOptions, workers: cli.defaultWorkers() })
        const seen = new Map<string, string>()
        const watch = execution.state.on('run-events', () => reportTasks(context, execution.state.current, seen))
        try {
          const result = await execution.start()
          reportTasks(context, execution.state.current, seen)
          if (!result.success) {
            throw new Error(context.signal.aborted ? 'the run was cancelled' : `${name} failed`)
          }
        } finally {
          watch.close()
        }
      }
    } finally {
      listener.close()
    }
  }
}

// A task event when a task has moved on since the last look.
function reportTasks(
  context: RunContext,
  workTree: Parameters<typeof iterateWorkTasks>[0],
  seen: Map<string, string>
): void {
  for (const task of iterateWorkTasks(workTree)) {
    const state = task.state.current
    let event: 'running' | 'succeeded' | 'failed' | 'cached' | null = null
    if (state.type === 'running') {
      event = 'running'
    } else if (state.type === 'completed') {
      event = state.skipped ? null : state.cached ? 'cached' : 'succeeded'
    } else if (state.type === 'error' || state.type === 'crash') {
      event = 'failed'
    }
    if (event && seen.get(task.name) !== event) {
      seen.set(task.name, event)
      context.emit({ type: 'task', task: task.name, state: event })
    }
  }
}
