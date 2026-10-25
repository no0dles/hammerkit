import { createInterface } from 'readline'
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
import { assertWorkTreePathsWithinRoot } from '../planner/utils/assert-item-paths'
import { scopeServiceVolumes } from '../planner/utils/hosted-volumes'
import { SecretCatalog } from '../secrets/secret-catalog'
import { createSecretRegistry } from '../utils/redact'
import { emptyWritable } from '../utils/empty-writable'
import { parseDuration } from '../utils/units'
import { runOptionsSchema } from './run-request'
import { networkSchema } from '../schema/network-schema'
import { limitNetwork, parseWorkNetwork, WorkNetwork } from '../planner/work-network'
import { getRunScopes } from './run-plan'
import { MAX_CAUSES, MAX_TASK_ERROR } from './runs'
import type { EndpointTarget, RunEventData, TaskStatus } from './runs'
import { WorkTree } from '../planner/work-tree'
import { getResourceName } from '../kubernetes/resources'
import { WorkKubernetesEnvironment } from '../planner/work-environment'

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
    // set when the build files are read from a directory of the run and work on the
    // files of a sandbox
    directory: z
      .object({ read: z.string().min(1), work: z.string().min(1) })
      .strict()
      .optional(),
    tasks: z.array(z.string()),
    options: runOptionsSchema,
    // the accounts the run was admitted for; a secret of any other is refused
    accounts: z.array(z.string()),
    // the operator's providers and accounts, as the server read them from its config
    catalog: z.custom<SecretCatalog>((value) => typeof value === 'object' && value !== null),
    // the cluster and namespace container tasks and services run in, on a Kubernetes backend
    kubernetes: z
      .custom<WorkKubernetesEnvironment>(
        (value) => typeof value === 'object' && value !== null && (value as any).type === 'kubernetes'
      )
      .optional(),
    // the most any task or service reaches besides its needs, as `--network`: `runs.network`
    network: networkSchema.optional(),
    // for a run on a sandbox, `sandboxes.network`: the run gets the lower of the two
    sandboxNetwork: networkSchema.optional(),
    // the caller and source trust of the run, in front of the names of its services' docker
    // volumes (see scopeServiceVolumes)
    volumeScope: z
      .string()
      .regex(/^[a-z]+-[0-9a-f]{24}$/)
      .optional(),
    // a service run: the services it keeps up instead of tasks, and the ports the server
    // reaches as endpoints
    up: z
      .object({
        services: z.array(z.string()).min(1),
        endpoints: z.array(z.object({ service: z.string(), port: z.number().int() }).strict()),
      })
      .strict()
      .optional(),
  })
  .strict()

export type WorkerInput = z.infer<typeof workerInputSchema>

// The ceiling of the run, combined here and not in the server: the lower of two allow lists
// marks what one allows only through a pattern, which a build file's `network` can't say.
export function getRunNetwork(input: Pick<WorkerInput, 'network' | 'sandboxNetwork'>): WorkNetwork | null {
  const runs = input.network ? parseWorkNetwork(input.network) : null
  return input.sandboxNetwork ? limitNetwork(parseWorkNetwork(input.sandboxNetwork), runs) : runs
}

// What the process says, one JSON object per line on its standard output.
export type WorkerMessage =
  | { kind: 'event'; event: RunEventData }
  // the services of a service run are ready
  | { kind: 'up'; targets: EndpointTarget[] }
  | { kind: 'result'; ok: boolean; error?: string }

/**
 * The ports of the services of a service run as the server publishes them: on a host the
 * ports of endpoints go to a free port of the loopback interface, where only the server
 * reaches them, and no other port goes to the host, whatever the build file says (`up`
 * would publish them on every interface, where two runs collide). On a cluster nothing is
 * published, the server reaches the Service of each.
 */
export function publishEndpoints(
  workTree: WorkTree,
  endpoints: { service: string; port: number }[],
  cluster: boolean
): void {
  for (const service of Object.values(workTree.services)) {
    if (!('ports' in service.data)) {
      continue
    }
    service.data.ports = service.data.ports.map((port) =>
      !cluster &&
      endpoints.some((endpoint) => endpoint.service === service.name && endpoint.port === port.containerPort)
        ? { containerPort: port.containerPort, hostPort: 0, hostIp: '127.0.0.1' }
        : { containerPort: port.containerPort, hostPort: null }
    )
  }
}

// Where the server reaches each endpoint, once every service the run keeps up is ready;
// null until then.
export function getEndpointTargets(
  workTree: WorkTree,
  up: NonNullable<WorkerInput['up']>,
  kubernetes: WorkKubernetesEnvironment | undefined
): EndpointTarget[] | null {
  const services = Object.values(workTree.services).filter((service) => up.services.includes(service.name))
  if (services.length < up.services.length || services.some((service) => service.state.current.type !== 'running')) {
    return null
  }
  const targets: EndpointTarget[] = []
  for (const endpoint of up.endpoints) {
    const service = services.find((candidate) => candidate.name === endpoint.service)
    const state = service?.state.current
    if (!service || state?.type !== 'running') {
      return null
    }
    if (kubernetes) {
      targets.push({
        service: endpoint.service,
        port: endpoint.port,
        address: { host: `${getResourceName(service, kubernetes)}.${kubernetes.namespace}.svc`, port: endpoint.port },
      })
      continue
    }
    const published = state.published?.find((candidate) => candidate.containerPort === endpoint.port)
    if (!published) {
      throw new Error(`${endpoint.service} is up, but its port ${endpoint.port} was not published`)
    }
    targets.push({
      service: endpoint.service,
      port: endpoint.port,
      address: { host: published.host, port: published.port },
    })
  }
  return targets
}

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
  emit: (event: RunEventData) => void,
  // a service run: its services are ready, at these addresses
  up?: (targets: EndpointTarget[]) => void
): Promise<void> {
  const secrets = createSecretRegistry()
  const status = statusConsole(emptyWritable(), secrets)
  // the process starts in a directory of the server, the tasks work on the run's files
  const work = input.directory?.work ?? cwd
  // what the engine would print to a terminal is not wanted, its status console
  // is what is streamed: it is redacted with the secrets of this run
  const environment: Environment = {
    processEnvs,
    hosted: { catalog: input.catalog, accounts: input.accounts, kubernetes: input.kubernetes },
    abortCtrl,
    cwd: work,
    file: getFileContext(work),
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
      network: getRunNetwork(input),
      // why a task was not taken from the cache goes into its result
      explain: true,
    }

    for (const { name, scope } of getRunScopes(input.tasks, options, input.up?.services)) {
      const { ctx, scope: parsed } = await createParseContext(input.entry, environment, {
        directory: input.directory,
      })
      const workTree = getWorkContext(await parseReferences(ctx, parsed, environment), scope, environment)
      await assertWorkTreePathsWithinRoot(workTree, work)
      if (input.volumeScope && !input.kubernetes) {
        scopeServiceVolumes(workTree, input.volumeScope)
      }
      if (input.up) {
        publishEndpoints(workTree, input.up.endpoints, !!input.kubernetes)
      }
      const cli = getCli(workTree, environment)
      if (cli.tasks().length === 0 && (!input.up || cli.services().length === 0)) {
        throw new Error(`no tasks found for ${name}`)
      }
      const execution = input.up
        ? cli.up({ ...execOptions, workers: cli.defaultWorkers(), daemon: false, wait: 'ready' })
        : cli.exec({ ...execOptions, workers: cli.defaultWorkers() })
      const seen = new Map<string, Seen>()
      let ready = false
      const report = () => {
        reportTasks(emit, execution.state.current, seen, (text) => secrets.redact(text))
        if (input.up && up && !ready) {
          const targets = getEndpointTargets(execution.state.current, input.up, input.kubernetes)
          if (targets) {
            ready = true
            up(targets)
          }
        }
      }
      const watch = execution.state.on('run-events', report)
      try {
        const result = await execution.start()
        report()
        // on a cluster the services stay in their Deployments once they are ready, until
        // the namespace of the run goes
        if (input.up && input.kubernetes && ready && result.success && !abortCtrl.signal.aborted) {
          await new Promise<void>((resolve) =>
            abortCtrl.signal.addEventListener('abort', () => resolve(), { once: true })
          )
          return
        }
        if (input.up && ready) {
          if (!abortCtrl.signal.aborted) {
            throw new Error('the services stopped on their own')
          }
          return
        }
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

// The run is the first line of the standard input. The server keeps it open and writes
// `cancel` on it to stop the run: that works the same on every platform, where a signal
// on Windows ends the process without letting it stop its tasks.
// `onEnd` is told when the input ends before the run does: the server is gone.
export function readInput(
  stdin: NodeJS.ReadableStream,
  cancel: () => void
): { input: Promise<string>; close: () => void; onEnd: (listener: () => void) => void } {
  const lines = createInterface({ input: stdin, crlfDelay: Infinity })
  let first: string | undefined
  let closing = false
  let ended = false
  let onEnd: (() => void) | undefined
  const input = new Promise<string>((resolve) => {
    lines.on('line', (line) => {
      if (first === undefined) {
        first = line
        resolve(line)
      } else if (line.trim() === 'cancel') {
        cancel()
      }
    })
    lines.on('close', () => {
      resolve(first ?? '')
      if (!closing) {
        ended = true
        onEnd?.()
      }
    })
  })
  return {
    input,
    close: () => {
      closing = true
      lines.close()
    },
    onEnd: (listener) => {
      onEnd = listener
      if (ended) {
        listener()
      }
    },
  }
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
  // the server stops a run with `cancel` on the standard input, anybody else with a signal
  let cancelled = false
  const stop = () => {
    cancelled = true
    abortCtrl.abort()
  }
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  signals.forEach((signal) => process.on(signal, stop))
  const reader = readInput(stdin, stop)
  let input: WorkerInput
  try {
    input = workerInputSchema.parse(JSON.parse(await reader.input))
  } catch (e) {
    reader.close()
    signals.forEach((signal) => process.off(signal, stop))
    say({ kind: 'result', ok: false, error: `the run could not be read: ${e instanceof Error ? e.message : e}` })
    return
  }
  if (input.up) {
    // services stay until they are stopped: without the server that would stop them, at
    // their ttl or on a cancel, nothing would
    reader.onEnd(stop)
  }
  try {
    await runTasks(
      input,
      cwd,
      processEnvs,
      abortCtrl,
      () => cancelled,
      (event) => say({ kind: 'event', event }),
      (targets) => say({ kind: 'up', targets })
    )
    say({ kind: 'result', ok: true })
  } catch (e) {
    say({ kind: 'result', ok: false, error: e instanceof Error ? e.message : String(e) })
  } finally {
    reader.close()
    signals.forEach((signal) => process.off(signal, stop))
  }
}
