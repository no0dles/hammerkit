import { mkdir, rm, writeFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { Environment } from '../executer/environment'
import { CliExecOptions, getCli } from '../cli'
import { getFileContext } from '../file/get-file-context'
import { consoleContext } from '../log'
import { isWithin } from '../includes/resolve-git-source'
import { LabelValues } from '../executer/label-values'
import { WorkScope } from '../executer/work-scope'
import { parseLabelArguments } from '../parser/parse-label-arguments'
import { createParseContext } from '../schema/schema-parser'
import { parseReferences } from '../schema/reference-parser'
import { getWorkContext } from '../schema/work-scope-parser'
import { statusConsole } from '../planner/work-item-status'
import { iterateWorkTasks } from '../planner/utils/plan-work-tasks'
import { createSecretRegistry } from '../utils/redact'
import { emptyWritable } from '../utils/empty-writable'
import { parseDuration } from '../utils/units'
import { DefinitionStore } from './definitions'
import { checkoutRef } from './git-checkout'
import { Run, RunContext, RunExecutor } from './runs'
import { ServerConfig } from './server-config'

// What a task on the server sees of the server's own environment: the tools it
// needs to find and reach docker, nothing the operator keeps there for the server.
const PASSED_ENVS = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'SSL_CERT_FILE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSH_AUTH_SOCK',
  // Windows: without these powershell and git can not find their profile
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  // powershell is very slow to start without it
  'PSModulePath',
]

// one log line of a task is cut here, the registry caps how many events a run keeps
const MAX_LOG_TEXT = 8 * 1024

export function passedEnvironment(envs: { [key: string]: string | undefined }): { [key: string]: string | undefined } {
  const passed: { [key: string]: string | undefined } = {}
  for (const name of PASSED_ENVS) {
    if (envs[name] !== undefined) {
      passed[name] = envs[name]
    }
  }
  return passed
}

export interface HostExecutorOptions {
  config: ServerConfig
  definitions: DefinitionStore
  // the server's own environment: where it runs and what it passes on
  environment: Environment
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
    const { definitions, config, environment } = this.options
    const version = definitions.find(run.definition.name, run.definition.hash)
    const bundle = version ? await definitions.files(version) : undefined
    if (!version || !bundle) {
      throw new Error(`the build file ${run.definition.name} at ${run.definition.hash} is no longer on this server`)
    }
    if (run.source.type !== 'ref') {
      throw new Error('runs from an upload are not supported by this server yet, use a git ref')
    }
    const repository = config.sources[run.definition.name]?.git
    if (!repository) {
      throw new Error(
        `this server has no repository for ${run.definition.name} to run ${run.source.ref} from, ` +
          `the operator sets sources.${run.definition.name}.git`
      )
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
      const passed = passedEnvironment(environment.processEnvs)
      const commit = await checkoutRef(repository, run.source.ref, checkout, passed, abortCtrl.signal)
      context.emit({ type: 'log', task: 'hammerkit', stream: 'stdout', text: `checked out ${commit}` })
      await this.writeBundle(checkout, bundle.files)
      await this.runTasks(run, context, join(checkout, version.entry), checkout, passed, abortCtrl)
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
    entry: string,
    cwd: string,
    passed: { [key: string]: string | undefined },
    abortCtrl: AbortController
  ): Promise<void> {
    const secrets = createSecretRegistry()
    const status = statusConsole(emptyWritable(), secrets)
    // what the engine would print to a terminal is not wanted, its status console
    // is what is streamed: it is redacted with the secrets of this run
    const environment: Environment = {
      processEnvs: passed,
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
      // the tasks in the order they were named; by labels when none is
      const scopes: { name: string; scope: WorkScope }[] =
        run.tasks.length > 0
          ? run.tasks.map((task) => ({
              name: task,
              scope: { taskName: task, environmentName: options.env ?? null },
            }))
          : [
              {
                name: 'labels',
                scope: {
                  filterLabels: labels(options.filter),
                  excludeLabels: labels(options.exclude),
                  environmentName: options.env ?? null,
                },
              },
            ]

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

function labels(values: string[] | undefined): LabelValues | undefined {
  return values && values.length > 0 ? parseLabelArguments(values) : undefined
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
