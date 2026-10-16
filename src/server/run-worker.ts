import { Writable } from 'stream'
import { z } from 'zod'
import { CliExecOptions, getCli } from '../cli'
import { Environment } from '../executer/environment'
import { getFileContext } from '../file/get-file-context'
import { consoleContext } from '../log'
import { createParseContext } from '../schema/schema-parser'
import { parseReferences } from '../schema/reference-parser'
import { getWorkContext } from '../schema/work-scope-parser'
import { statusConsole } from '../planner/work-item-status'
import { iterateWorkTasks } from '../planner/utils/plan-work-tasks'
import { SecretCatalog } from '../secrets/secret-catalog'
import { createSecretRegistry } from '../utils/redact'
import { emptyWritable } from '../utils/empty-writable'
import { parseDuration } from '../utils/units'
import { runOptionsSchema } from './run-request'
import { getRunScopes } from './run-plan'
import { MAX_CAUSES, MAX_TASK_ERROR } from './runs'
import type { RunEventData, TaskStatus } from './runs'

// one log line of a task is cut here, the registry caps how many events a run keeps
const MAX_LOG_TEXT = 8 * 1024

/**
 * What the process that executes a run is told, on its standard input. A run executes
 * in a process of its own, started with an environment the server built, so what the
 * engine reads of its process (the home directory, the docker host, the cache directory)
 * is the run's and not the server's.
 */
export const workerInputSchema = z
  .object({
    // the build file to start from, in the checkout
    entry: z.string().min(1),
    tasks: z.array(z.string()),
    options: runOptionsSchema,
    // the accounts the run was admitted for; a secret of any other is refused
    accounts: z.array(z.string()),
    // the operator's providers and accounts, as the server read them from its config
    catalog: z.custom<SecretCatalog>((value) => typeof value === 'object' && value !== null),
  })
  .strict()

export type WorkerInput = z.infer<typeof workerInputSchema>

// What the process says, one JSON object per line on its standard output.
export type WorkerMessage = { kind: 'event'; event: RunEventData } | { kind: 'result'; ok: boolean; error?: string }

/**
 * Executes the tasks of a run with the engine of `hammerkit run`. The caller says which
 * process this is in: it reports what happens through `emit` and stops when `abortCtrl`
 * is aborted.
 */
export async function runTasks(
  input: WorkerInput,
  cwd: string,
  processEnvs: { [key: string]: string | undefined },
  abortCtrl: AbortController,
  // whether the run was stopped from outside; the engine aborts too when a task fails
  cancelled: () => boolean,
  emit: (event: RunEventData) => void
): Promise<void> {
  const secrets = createSecretRegistry()
  const status = statusConsole(emptyWritable(), secrets)
  // what the engine would print to a terminal is not wanted, its status console
  // is what is streamed: it is redacted with the secrets of this run
  const environment: Environment = {
    processEnvs,
    hosted: { catalog: input.catalog, accounts: input.accounts },
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
      emit({
        type: 'log',
        task: message.context.name,
        stream: message.console,
        text: message.message.slice(0, MAX_LOG_TEXT),
      })
    } else if (message.level === 'error' || message.level === 'warn') {
      emit({
        type: 'log',
        task: message.context.name,
        stream: 'stderr',
        text: message.message.slice(0, MAX_LOG_TEXT),
      })
    }
  })

  try {
    const options = input.options
    const execOptions: Partial<CliExecOptions> = {
      logMode: 'live',
      cacheDefault: options.cache ?? 'checksum',
      cacheReadOnly: options.cacheReadOnly ?? false,
      timeout: options.timeout ? parseDuration(options.timeout) : null,
      skipDeps: options.skipDeps !== false,
      // why a task was not taken from the cache goes into its result
      explain: true,
    }

    for (const { name, scope } of getRunScopes(input.tasks, options)) {
      const { ctx, scope: parsed } = await createParseContext(input.entry, environment)
      const workTree = getWorkContext(await parseReferences(ctx, parsed, environment), scope, environment)
      const cli = getCli(workTree, environment)
      if (cli.tasks().length === 0) {
        throw new Error(`no tasks found for ${name}`)
      }
      const execution = cli.exec({ ...execOptions, workers: cli.defaultWorkers() })
      const seen = new Map<string, Seen>()
      const report = () => reportTasks(emit, execution.state.current, seen, (text) => secrets.redact(text))
      const watch = execution.state.on('run-events', report)
      try {
        const result = await execution.start()
        report()
        if (!result.success) {
          throw new Error(cancelled() ? 'the run was cancelled' : `${name} failed`)
        }
      } finally {
        watch.close()
      }
    }
  } finally {
    listener.close()
  }
}

interface Seen {
  status?: TaskStatus
  // when it started, which a failed task's state does not say anymore
  started?: number
}

// Why a task ran, as a task event carries it: the first causes, masked and cut short.
export function taskCauses(causes: string[] | undefined, redact: (text: string) => string): { causes?: string[] } {
  return causes?.length
    ? {
        causes: [
          ...causes.slice(0, MAX_CAUSES).map((cause) => redact(cause).slice(0, MAX_TASK_ERROR)),
          ...(causes.length > MAX_CAUSES ? [`… and ${causes.length - MAX_CAUSES} more`] : []),
        ],
      }
    : {}
}

// A task event when a task has moved on since the last look, with what its result needs
// once it is over.
function reportTasks(
  emit: (event: RunEventData) => void,
  workTree: Parameters<typeof iterateWorkTasks>[0],
  seen: Map<string, Seen>,
  // what leaves the process is masked like the log is: an error may quote a value
  redact: (text: string) => string
): void {
  for (const task of iterateWorkTasks(workTree)) {
    const state = task.state.current
    const before = seen.get(task.name)
    const started = 'started' in state ? state.started.getTime() : before?.started
    const since = () => (started !== undefined ? { durationMs: Math.max(0, Date.now() - started) } : {})
    let event: Extract<RunEventData, { type: 'task' }> | null = null
    if (state.type === 'running') {
      event = { type: 'task', task: task.name, state: 'running' }
    } else if (state.type === 'completed') {
      const status = state.skipped ? 'skipped' : state.cached ? 'cached' : 'succeeded'
      event = {
        type: 'task',
        task: task.name,
        state: status,
        ...(status === 'skipped' ? {} : { durationMs: state.duration }),
        ...taskCauses(state.missCauses, redact),
      }
    } else if (state.type === 'crash') {
      event = { type: 'task', task: task.name, state: 'failed', exitCode: state.exitCode, ...since() }
    } else if (state.type === 'error') {
      const error = redact(state.errorMessage).slice(0, MAX_TASK_ERROR)
      event = { type: 'task', task: task.name, state: 'failed', error, ...since() }
    } else if (state.type === 'canceled') {
      event = { type: 'task', task: task.name, state: 'cancelled' }
    }
    if (event && before?.status !== event.state) {
      seen.set(task.name, { status: event.state, started })
      emit(event)
    } else if (started !== undefined && before?.started === undefined) {
      seen.set(task.name, { status: before?.status, started })
    }
  }
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * The process of one run: reads its input, executes the tasks in the current directory
 * and reports as lines of JSON. It exits 0 when it could say how the run ended, and the
 * server reads that from the last line; a process that dies before has crashed.
 */
export async function workerMain(
  stdin: NodeJS.ReadableStream,
  stdout: Writable,
  processEnvs: { [key: string]: string | undefined },
  cwd: string,
  abortCtrl: AbortController
): Promise<void> {
  const say = (message: WorkerMessage) => stdout.write(`${JSON.stringify(message)}\n`)
  // the server stops a run with a signal
  let cancelled = false
  const stop = () => {
    cancelled = true
    abortCtrl.abort()
  }
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  signals.forEach((signal) => process.on(signal, stop))
  let input: WorkerInput
  try {
    input = workerInputSchema.parse(JSON.parse(await readAll(stdin)))
  } catch (e) {
    say({ kind: 'result', ok: false, error: `the run could not be read: ${e instanceof Error ? e.message : e}` })
    return
  }
  try {
    await runTasks(
      input,
      cwd,
      processEnvs,
      abortCtrl,
      () => cancelled,
      (event) => say({ kind: 'event', event })
    )
    say({ kind: 'result', ok: true })
  } catch (e) {
    say({ kind: 'result', ok: false, error: e instanceof Error ? e.message : String(e) })
  } finally {
    signals.forEach((signal) => process.off(signal, stop))
  }
}
